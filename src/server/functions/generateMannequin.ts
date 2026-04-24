// On-demand "See on me" mannequin render for a single outfit.
//
// Triggered by the SEE ON ME button in the Three Looks sheet. Uses Lovable AI
// image-edit (Nano Banana 2) to compose all the outfit's items onto a single
// model figure, optionally using the user's reference photo as an identity
// hint. Result is cached to outfits.mannequin_path so re-tapping is instant.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateImage, ImageGenError, dataUrlToBytes } from "@/server/lib/ai-image";

interface MannequinInput {
  outfit_id: string;
}

const ENHANCED_BUCKET = "wardrobe-enhanced";
const THUMB_BUCKET = "wardrobe-thumbs";
const RENDER_BUCKET = "outfit-renders";
const REFERENCE_BUCKET = "user-references";

const SYSTEM_HINT = `Generate a single full-body editorial fashion photograph in the SSENSE / Mr Porter / The Row visual style. A standing model wearing EXACTLY the items shown in the reference garment images, composed as one cohesive outfit. The garments must match the references precisely in color, material, cut, and proportion. Soft diffused studio lighting, flat #C9C5BC warm-grey backdrop, 35mm aesthetic, sharp focus throughout, no props, no text, no logos, no watermarks.`;

const FRAMING_HINT = `STRICT FRAMING:
- Frame from top of head to mid-thigh or feet — never crop the face.
- 8% padding above the head minimum.
- Sharp focus on eyes, eye-level camera, three-quarter or front pose.
- Centered horizontally, plenty of negative space.`;

const FACE_HINT = `IDENTITY: The first attached image is a reference photo of the model. Reproduce the SAME person — same facial structure, eyes, nose, mouth, skin tone, hair color and hairstyle, and build. The face must be clearly recognizable as the same individual. Do not stylize or smooth the face.`;

export const generateMannequin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: MannequinInput) => {
    if (typeof input.outfit_id !== "string" || input.outfit_id.length < 8) {
      throw new Error("invalid_outfit_id");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. Load outfit (RLS-scoped via user supabase client)
    const { data: outfit, error: outfitErr } = await supabase
      .from("outfits")
      .select("id, item_ids, mannequin_path, mannequin_status, name")
      .eq("id", data.outfit_id)
      .maybeSingle();
    if (outfitErr) throw outfitErr;
    if (!outfit) return { error: "not_found" as const };

    // Cache hit
    if (outfit.mannequin_path) {
      return {
        ok: true as const,
        mannequin_path: outfit.mannequin_path,
        cached: true,
      };
    }

    // Mark rendering
    await supabaseAdmin
      .from("outfits")
      .update({ mannequin_status: "rendering", mannequin_error: null })
      .eq("id", outfit.id);

    // 2. Load items
    const { data: items, error: itemsErr } = await supabase
      .from("wardrobe_items")
      .select("id, enhanced_path, thumbnail_path, category, color_primary, material, subcategory")
      .in("id", outfit.item_ids ?? []);
    if (itemsErr) throw itemsErr;
    if (!items || items.length === 0) {
      await supabaseAdmin
        .from("outfits")
        .update({ mannequin_status: "failed", mannequin_error: "no_items" })
        .eq("id", outfit.id);
      return { error: "no_items" as const };
    }

    // 3. Resolve garment image URLs
    const itemRefs: { url: string; descriptor: string }[] = [];
    for (const item of items) {
      let url: string | null = null;
      if (item.enhanced_path) {
        url = supabaseAdmin.storage
          .from(ENHANCED_BUCKET)
          .getPublicUrl(item.enhanced_path).data.publicUrl;
      } else if (item.thumbnail_path) {
        url = supabaseAdmin.storage
          .from(THUMB_BUCKET)
          .getPublicUrl(item.thumbnail_path).data.publicUrl;
      }
      if (!url) continue;
      const desc = [item.category, item.color_primary, item.material, item.subcategory]
        .filter(Boolean)
        .join(" ");
      itemRefs.push({ url, descriptor: desc });
    }
    if (itemRefs.length === 0) {
      await supabaseAdmin
        .from("outfits")
        .update({ mannequin_status: "failed", mannequin_error: "no_item_images" })
        .eq("id", outfit.id);
      return { error: "no_item_images" as const };
    }

    // 4. Optional reference photo for identity match
    let referenceUrl: string | null = null;
    try {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("reference_photo_path")
        .eq("id", userId)
        .maybeSingle();
      if (profile?.reference_photo_path) {
        const { data: signed } = await supabaseAdmin.storage
          .from(REFERENCE_BUCKET)
          .createSignedUrl(profile.reference_photo_path, 60 * 10);
        if (signed?.signedUrl) referenceUrl = signed.signedUrl;
      }
    } catch (err) {
      console.warn("[generateMannequin] reference lookup failed", err);
    }

    // 5. Build the prompt
    const itemList = itemRefs
      .map((r, i) => `  ${i + 1}. ${r.descriptor || "garment"}`)
      .join("\n");

    const promptText = `${SYSTEM_HINT}

${FRAMING_HINT}
${referenceUrl ? `\n${FACE_HINT}\n` : ""}
The model is wearing these specific items (each shown in the attached garment reference images, in order):
${itemList}

Compose all items together on the same model in a single sharp, high-resolution frame. Three-quarter or full-body framing — head and full face must be inside the frame.`;

    const parts: Array<{
      type: "text" | "image_url";
      text?: string;
      image_url?: { url: string };
    }> = [{ type: "text", text: promptText }];
    if (referenceUrl) parts.push({ type: "image_url", image_url: { url: referenceUrl } });
    for (const r of itemRefs) parts.push({ type: "image_url", image_url: { url: r.url } });

    // 6. Call image gateway with retry
    const MAX_ATTEMPTS = 3;
    let dataUrl: string | null = null;
    let lastError: { code: string; message: string } | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        dataUrl = await generateImage({
          model: "google/gemini-3.1-flash-image-preview",
          parts,
          timeoutMs: 120_000,
        });
        lastError = null;
        break;
      } catch (err) {
        const code = err instanceof ImageGenError ? err.code : "unknown";
        const message =
          err instanceof Error ? err.message : "unknown image gen error";
        lastError = { code, message };
        console.error(
          `[generateMannequin] attempt ${attempt}/${MAX_ATTEMPTS} failed`,
          code,
          message,
        );
        if (code === "payment_required") break;
        if (attempt < MAX_ATTEMPTS) {
          const base = 800 * Math.pow(2, attempt - 1);
          const jitter = Math.floor(Math.random() * 400);
          await new Promise((r) => setTimeout(r, Math.min(base + jitter, 5000)));
        }
      }
    }

    if (!dataUrl) {
      const errMsg = `${lastError?.code ?? "unknown"}: ${lastError?.message ?? "no image"}`;
      await supabaseAdmin
        .from("outfits")
        .update({ mannequin_status: "failed", mannequin_error: errMsg })
        .eq("id", outfit.id);
      return {
        error: "render_failed" as const,
        code: lastError?.code ?? "unknown",
        message: errMsg,
      };
    }

    // 7. Upload to outfit-renders bucket under a /mannequin/ subpath
    const { bytes, contentType } = dataUrlToBytes(dataUrl);
    const ext = contentType.includes("png") ? "png" : "jpg";
    const path = `${userId}/mannequin/${outfit.id}.${ext}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(RENDER_BUCKET)
      .upload(path, bytes, {
        contentType,
        upsert: true,
        cacheControl: "31536000",
      });
    if (uploadErr) {
      await supabaseAdmin
        .from("outfits")
        .update({
          mannequin_status: "failed",
          mannequin_error: `upload_failed: ${uploadErr.message}`,
        })
        .eq("id", outfit.id);
      return { error: "upload_failed" as const };
    }

    await supabaseAdmin
      .from("outfits")
      .update({
        mannequin_path: path,
        mannequin_status: "ready",
        mannequin_error: null,
      })
      .eq("id", outfit.id);

    return { ok: true as const, mannequin_path: path };
  });

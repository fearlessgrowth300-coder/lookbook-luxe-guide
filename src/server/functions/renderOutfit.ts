// Render an AI-composed image of a model wearing the outfit's items.
// Uses Nano Banana 2 (google/gemini-3.1-flash-image-preview) with the
// background-removed item PNGs as visual references.
//
// Flow:
// 1. Auth via requireSupabaseAuth.
// 2. Load outfit + items (must belong to user via RLS).
// 3. Build a styling prompt + attach each item image as image_url part.
// 4. Call image gateway, decode base64, upload to outfit-renders bucket.
// 5. Update outfits.render_path + render_status.
//
// This is intentionally a separate server function from suggestOutfit so the
// initial composition stays fast — renders are kicked off in the background
// after the user sees the names + rationales, and the UI polls/swaps in the
// image when ready.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { generateImage, ImageGenError, dataUrlToBytes } from "@/server/lib/ai-image";

interface RenderInput {
  outfit_id: string;
}

const ENHANCED_BUCKET = "wardrobe-enhanced";
const THUMB_BUCKET = "wardrobe-thumbs";
const RENDER_BUCKET = "outfit-renders";
const REFERENCE_BUCKET = "user-references";

const RENDER_SYSTEM_HINT = `Generate a single high-resolution editorial fashion photograph in the SSENSE / Mr Porter / The Row visual style. A standing model wearing EXACTLY the items shown in the reference garment images, composed as one cohesive outfit. The garments must match the references precisely in color, material, cut, and proportion — do not invent details. Soft diffused studio lighting, flat #C9C5BC warm-grey backdrop, 35mm aesthetic, sharp focus throughout, crisp detail, no props, no text, no logos, no watermarks.`;

const FRAMING_HINT = `STRICT FRAMING RULES (do not violate):
- Frame the subject from the top of the head to mid-thigh or to the feet — NEVER crop the face or top of the head.
- The entire face must be fully visible inside the frame with at least 8% padding above the head.
- Sharp tack-focus on the eyes; both eyes clearly in focus and well-lit. Other elements may have shallow depth of field but the eyes must be sharpest.
- Camera at eye level, subject centered horizontally, three-quarter or front pose.
- High resolution, no motion blur, no soft-focus filter, no heavy bokeh on the face.`;

const FACE_CONSISTENCY_HINT = `IDENTITY: The first attached image is a reference photo of the model. Reproduce the SAME person — same facial structure, eyes, nose, mouth, skin tone, hair color and hairstyle, and build. The face must be clearly recognizable as the same individual across renders. Do not stylize, smooth, or alter the face.`;

export const renderOutfit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: RenderInput) => {
    if (typeof input.outfit_id !== "string" || input.outfit_id.length < 8) {
      throw new Error("invalid_outfit_id");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. Load outfit
    const { data: outfit, error: outfitErr } = await supabase
      .from("outfits")
      .select("id, item_ids, render_path, render_status, name")
      .eq("id", data.outfit_id)
      .maybeSingle();
    if (outfitErr) throw outfitErr;
    if (!outfit) {
      return { error: "not_found" as const };
    }
    if (outfit.render_path) {
      return { ok: true as const, render_path: outfit.render_path, cached: true };
    }

    // Mark as rendering so the UI shows a "composing" state. Clear stale error.
    await supabaseAdmin
      .from("outfits")
      .update({ render_status: "rendering", render_error: null })
      .eq("id", outfit.id);

    // 2. Load items
    const { data: items, error: itemsErr } = await supabase
      .from("wardrobe_items")
      .select("id, enhanced_path, thumbnail_path, category, subcategory, color_primary, material")
      .in("id", outfit.item_ids ?? []);
    if (itemsErr) throw itemsErr;
    if (!items || items.length === 0) {
      await supabaseAdmin
        .from("outfits")
        .update({ render_status: "failed" })
        .eq("id", outfit.id);
      return { error: "no_items" as const };
    }

    // 3. Resolve image URLs for each item — prefer background-removed
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
      const desc = [
        item.category,
        item.color_primary,
        item.material,
        item.subcategory,
      ]
        .filter(Boolean)
        .join(" ");
      itemRefs.push({ url, descriptor: desc });
    }

    if (itemRefs.length === 0) {
      await supabaseAdmin
        .from("outfits")
        .update({ render_status: "failed" })
        .eq("id", outfit.id);
      return { error: "no_item_images" as const };
    }

    // 4. Try to load the user's reference photo (private bucket → signed URL).
    let referenceUrl: string | null = null;
    try {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("reference_photo_path")
        .eq("id", userId)
        .maybeSingle();
      const refPath = profile?.reference_photo_path;
      if (refPath) {
        const { data: signed } = await supabaseAdmin.storage
          .from(REFERENCE_BUCKET)
          .createSignedUrl(refPath, 60 * 10);
        if (signed?.signedUrl) referenceUrl = signed.signedUrl;
      }
    } catch (err) {
      console.warn("[renderOutfit] reference photo lookup failed", err);
    }

    // 5. Build the prompt — text first, then reference photo (if any), then garments.
    const itemList = itemRefs
      .map((r, i) => `  ${i + 1}. ${r.descriptor || "garment"}`)
      .join("\n");

    const promptText = `${RENDER_SYSTEM_HINT}

${FRAMING_HINT}
${referenceUrl ? `\n${FACE_CONSISTENCY_HINT}\n` : ""}
The model is wearing these specific items (each shown in the attached garment reference images, in order):
${itemList}

Compose all items together on the same model in a single sharp, high-resolution frame. Three-quarter or full-body framing — head and full face must be inside the frame.`;

    const parts: Array<{ type: "text" | "image_url"; text?: string; image_url?: { url: string } }> = [
      { type: "text", text: promptText },
    ];
    if (referenceUrl) {
      parts.push({ type: "image_url", image_url: { url: referenceUrl } });
    }
    for (const r of itemRefs) {
      parts.push({ type: "image_url", image_url: { url: r.url } });
    }

    // 6. Call the gateway with exponential backoff retry. Total attempts: 3.
    //    Backoff schedule: 0ms, 800ms, 2400ms (jittered).
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
          err instanceof Error ? err.message : "Unknown image gen error";
        lastError = { code, message };
        console.error(
          `[renderOutfit] image gen attempt ${attempt}/${MAX_ATTEMPTS} failed`,
          code,
          message,
        );
        // Don't retry on terminal errors
        if (code === "payment_required") break;
        if (attempt < MAX_ATTEMPTS) {
          const base = 800 * Math.pow(2, attempt - 1); // 800, 1600, 3200…
          const jitter = Math.floor(Math.random() * 400);
          await new Promise((r) => setTimeout(r, Math.min(base + jitter, 5000)));
        }
      }
    }

    if (!dataUrl) {
      const errMsg = `${lastError?.code ?? "unknown"}: ${lastError?.message ?? "no image returned"}`;
      await supabaseAdmin
        .from("outfits")
        .update({ render_status: "failed", render_error: errMsg })
        .eq("id", outfit.id);
      return { error: "render_failed" as const, code: lastError?.code ?? "unknown", message: errMsg };
    }

    // 6. Decode + upload
    const { bytes, contentType } = dataUrlToBytes(dataUrl);
    const ext = contentType.includes("png") ? "png" : "jpg";
    const path = `${userId}/${outfit.id}.${ext}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from(RENDER_BUCKET)
      .upload(path, bytes, {
        contentType,
        upsert: true,
        cacheControl: "31536000",
      });
    if (uploadErr) {
      console.error("[renderOutfit] upload failed", uploadErr);
      await supabaseAdmin
        .from("outfits")
        .update({
          render_status: "failed",
          render_error: `upload_failed: ${uploadErr.message}`,
        })
        .eq("id", outfit.id);
      return { error: "upload_failed" as const };
    }

    // 7. Persist
    await supabaseAdmin
      .from("outfits")
      .update({ render_path: path, render_status: "ready", render_error: null })
      .eq("id", outfit.id);

    return { ok: true as const, render_path: path };
  });

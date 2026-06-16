// Server-side helpers for managing reference-photo candidates and resolving
// signed URLs for the user's chosen photo. Reads from the private
// `user-references` bucket. The "active" photo is whatever path is stored on
// `profiles.reference_photo_path`. Other files in the user's folder are
// treated as candidate retakes.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";






const REF_BUCKET = "user-references";

interface CandidatePhoto {
  path: string;
  signedUrl: string | null;
  is_active: boolean;
  created_at: string | null;
  size: number | null;
}



/** List every reference-photo candidate the user has uploaded. */
export const listReferencePhotos = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{
    candidates: CandidatePhoto[];
    activePath: string | null;
    activeSignedUrl: string | null;
  }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("reference_photo_path")
      .eq("id", userId)
      .maybeSingle();
    let activePath = profile?.reference_photo_path ?? null;

    const { data: files } = await supabaseAdmin.storage
      .from(REF_BUCKET)
      .list(userId, { limit: 50, sortBy: { column: "created_at", order: "desc" } });

    // Auto-heal: if the user has uploaded photos but no active reference is
    // recorded (or the recorded one no longer exists), promote the most
    // recent shot. Without this, renders silently skip identity guidance.
    const fileNames = new Set((files ?? []).map((f: { name: string }) => `${userId}/${f.name}`));
    if ((!activePath || !fileNames.has(activePath)) && files && files.length > 0) {
      const promoted = `${userId}/${files[0].name}`;
      const { error: promoteErr } = await supabaseAdmin
        .from("profiles")
        .update({ reference_photo_path: promoted })
        .eq("id", userId);
      if (!promoteErr) {
        activePath = promoted;
      }
    }

    const candidates: CandidatePhoto[] = [];
    for (const f of files ?? []) {
      const path = `${userId}/${f.name}`;
      const { data: signed } = await supabaseAdmin.storage
        .from(REF_BUCKET)
        .createSignedUrl(path, 60 * 60);
      candidates.push({
        path,
        signedUrl: signed?.signedUrl ?? null,
        is_active: path === activePath,
        created_at: f.created_at ?? null,
        size: (f.metadata as { size?: number } | null)?.size ?? null,
      });
    }

    let activeSignedUrl: string | null = null;
    if (activePath) {
      const found = candidates.find((c) => c.path === activePath);
      activeSignedUrl = found?.signedUrl ?? null;
      if (!activeSignedUrl) {
        const { data: signed } = await supabaseAdmin.storage
          .from(REF_BUCKET)
          .createSignedUrl(activePath, 60 * 60);
        activeSignedUrl = signed?.signedUrl ?? null;
      }
    }

    return { candidates, activePath, activeSignedUrl };
  });

/** Mark one of the user's existing photos as the active reference. */
export const setActiveReferencePhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { path: string | null }) => {
    if (input.path !== null && typeof input.path !== "string") {
      throw new Error("invalid_path");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    // Guard: path must live in the caller's folder
    if (data.path && !data.path.startsWith(`${userId}/`)) {
      throw new Error("forbidden_path");
    }
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ reference_photo_path: data.path })
      .eq("id", userId);
    if (error) throw error;
    return { ok: true as const };
  });

/** Delete a candidate. If it was the active one, also clear the profile pointer. */
export const deleteReferencePhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { path: string }) => {
    if (typeof input.path !== "string" || input.path.length < 1) {
      throw new Error("invalid_path");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    if (!data.path.startsWith(`${userId}/`)) {
      throw new Error("forbidden_path");
    }
    await supabaseAdmin.storage.from(REF_BUCKET).remove([data.path]);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("reference_photo_path")
      .eq("id", userId)
      .maybeSingle();
    if (profile?.reference_photo_path === data.path) {
      await supabaseAdmin
        .from("profiles")
        .update({ reference_photo_path: null })
        .eq("id", userId);
    }
    return { ok: true as const };
  });

/** Diagnostics: confirm the active photo's signed URL actually fetches. */
export const checkReferencePhotoHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { userId } = context;
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("reference_photo_path")
      .eq("id", userId)
      .maybeSingle();
    const path = profile?.reference_photo_path ?? null;

    if (!path) {
      return {
        stored: false,
        path: null,
        signed_url_ok: false,
        http_status: null,
        content_type: null,
        bytes: null,
        error: null as string | null,
      };
    }

    const { data: signed, error: signErr } = await supabaseAdmin.storage
      .from(REF_BUCKET)
      .createSignedUrl(path, 120);
    if (signErr || !signed?.signedUrl) {
      return {
        stored: true,
        path,
        signed_url_ok: false,
        http_status: null,
        content_type: null,
        bytes: null,
        error: signErr?.message ?? "could_not_sign",
      };
    }

    try {
      const r = await fetch(signed.signedUrl, { method: "GET" });
      const buf = r.ok ? await r.arrayBuffer() : null;
      return {
        stored: true,
        path,
        signed_url_ok: r.ok,
        http_status: r.status,
        content_type: r.headers.get("content-type"),
        bytes: buf?.byteLength ?? null,
        error: r.ok ? null : `http_${r.status}`,
      };
    } catch (err) {
      return {
        stored: true,
        path,
        signed_url_ok: false,
        http_status: null,
        content_type: null,
        bytes: null,
        error: err instanceof Error ? err.message : "fetch_failed",
      };
    }
  });

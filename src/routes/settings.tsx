import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useRef, useState } from "react";
import {
  Upload,
  X,
  Check,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { tap } from "@/lib/motion";
import {
  listReferencePhotos,
  setActiveReferencePhoto,
  deleteReferencePhoto,
  checkReferencePhotoHealth,
} from "@/server/functions/referencePhotos";
import { getIntegrationStatus } from "@/server/functions/integrationStatus";

export const Route = createFileRoute("/settings")({
  component: () => (
    <ProtectedRoute>
      <SettingsPage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Settings — Atelier" }] }),
});

const ARCHETYPES = ["minimalist", "classic", "eclectic", "romantic", "edgy", "sporty"] as const;
const CLIMATES = ["tropical", "temperate", "continental", "cold"] as const;

function SettingsPage() {
  const { user, signOut } = useAuth();
  const qc = useQueryClient();

  const profile = useQuery({
    queryKey: ["profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user!.id)
        .single();
      return data;
    },
  });

  const update = useMutation({
    mutationFn: async (patch: { style_archetype?: string; climate?: string }) => {
      const { error } = await supabase
        .from("profiles")
        .update(patch)
        .eq("id", user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", user?.id] });
      toast("Saved");
    },
  });

  return (
    <Shell>
      <div className="mx-auto max-w-[760px] px-6 py-16">
        <h1 className="font-display text-[32px] font-light text-graphite">Settings</h1>
        <p className="mt-2 text-[14px] text-ink">{user?.email}</p>

        <ReferenceWorkflow userId={user!.id} />

        <FacePreviewSection userId={user!.id} />

        <IntegrationsSection />

        <DiagnosticsPanel />

        <section className="mt-16">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Style archetype
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {ARCHETYPES.map((a) => {
              const active = profile.data?.style_archetype === a;
              return (
                <motion.button
                  {...tap}
                  key={a}
                  onClick={() => update.mutate({ style_archetype: a })}
                  className={`h-10 rounded-full px-5 text-[13px] capitalize transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {a}
                </motion.button>
              );
            })}
          </div>
        </section>

        <section className="mt-12">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
            Climate
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {CLIMATES.map((c) => {
              const active = profile.data?.climate === c;
              return (
                <motion.button
                  {...tap}
                  key={c}
                  onClick={() => update.mutate({ climate: c })}
                  className={`h-10 rounded-full px-5 text-[13px] capitalize transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {c}
                </motion.button>
              );
            })}
          </div>
        </section>

        <section className="mt-16 border-t border-linen pt-8">
          <motion.button
            {...tap}
            onClick={signOut}
            className="font-mono text-[11px] uppercase tracking-[0.16em] text-signal hover:text-graphite"
          >
            Sign out
          </motion.button>
        </section>
      </div>
    </Shell>
  );
}

/* ────────────────── Reference photo: multi-shot retake workflow ────────────────── */

function ReferenceWorkflow({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const photosQuery = useQuery({
    queryKey: ["reference-photos"],
    queryFn: () => listReferencePhotos(),
  });

  const setActive = useMutation({
    mutationFn: (path: string) => setActiveReferencePhoto({ data: { path } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reference-photos"] });
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["reference-health"] });
      toast.success("Reference photo set");
    },
    onError: () => toast.error("Couldn't set as active"),
  });

  const removePhoto = useMutation({
    mutationFn: (path: string) => deleteReferencePhoto({ data: { path } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["reference-photos"] });
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["reference-health"] });
      toast("Removed");
    },
  });

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      let lastUploadedPath: string | null = null;
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          toast.error(`${file.name} isn't an image`);
          continue;
        }
        if (file.size > 8 * 1024 * 1024) {
          toast.error(`${file.name} is over 8 MB`);
          continue;
        }
        const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
        // Unique filename per shot so several can coexist as candidates.
        const stamp = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
        const path = `${userId}/shot-${stamp}.${ext}`;
        const { error } = await supabase.storage
          .from("user-references")
          .upload(path, file, {
            upsert: false,
            contentType: file.type,
            cacheControl: "3600",
          });
        if (error) {
          toast.error(`Upload failed: ${error.message}`);
          continue;
        }
        lastUploadedPath = path;
      }
      // If no photo was previously active, mark the first new one as active.
      const hadActive = photosQuery.data?.activePath;
      if (!hadActive && lastUploadedPath) {
        await setActiveReferencePhoto({ data: { path: lastUploadedPath } });
      }
      qc.invalidateQueries({ queryKey: ["reference-photos"] });
      qc.invalidateQueries({ queryKey: ["profile"] });
      qc.invalidateQueries({ queryKey: ["reference-health"] });
    } finally {
      setBusy(false);
    }
  };

  const candidates = photosQuery.data?.candidates ?? [];
  const activePath = photosQuery.data?.activePath ?? null;

  return (
    <section className="mt-12">
      <div className="flex items-baseline justify-between">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Reference photos
        </p>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
          {candidates.length} shot{candidates.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="mt-2 text-[13px] text-graphite/80">
        Upload several head-and-shoulders shots and pick the best one. The active photo is
        used to keep the model's face consistent across every render.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="mt-5 flex items-center gap-3">
        <motion.button
          {...tap}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="inline-flex h-10 items-center gap-2 rounded-full bg-graphite px-5 text-[13px] text-bone disabled:opacity-50"
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
          {candidates.length === 0 ? "Upload photos" : "Add more shots"}
        </motion.button>
        {candidates.length > 0 && (
          <motion.button
            {...tap}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 px-3 font-mono text-[10px] uppercase tracking-[0.16em] text-graphite hover:text-noir"
          >
            <RefreshCw className="h-3 w-3" strokeWidth={1.5} />
            Retake
          </motion.button>
        )}
      </div>

      {photosQuery.isLoading ? (
        <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.18em] text-ink/60">
          Loading shots…
        </p>
      ) : candidates.length === 0 ? (
        <div className="mt-6 flex h-[140px] items-center justify-center border border-dashed border-linen bg-linen/30 px-4 text-center text-[12px] text-ink/70">
          No reference photo yet. Upload one or more shots above.
        </div>
      ) : (
        <div className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-4">
          {candidates.map((c) => {
            const active = c.path === activePath;
            return (
              <div
                key={c.path}
                className={`group relative aspect-[3/4] overflow-hidden border ${
                  active ? "border-graphite" : "border-linen"
                } bg-linen/40`}
              >
                {c.signedUrl ? (
                  <img
                    src={c.signedUrl}
                    alt="Reference shot"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink/60">
                      missing
                    </span>
                  </div>
                )}
                {active && (
                  <div className="absolute left-1.5 top-1.5 flex h-5 items-center gap-1 rounded-full bg-graphite px-2 font-mono text-[8px] uppercase tracking-[0.2em] text-bone">
                    <Check className="h-2.5 w-2.5" strokeWidth={2} />
                    Active
                  </div>
                )}
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-noir/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {!active && (
                    <button
                      onClick={() => setActive.mutate(c.path)}
                      disabled={setActive.isPending}
                      className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone hover:text-white"
                    >
                      Use this
                    </button>
                  )}
                  <button
                    onClick={() => removePhoto.mutate(c.path)}
                    disabled={removePhoto.isPending}
                    aria-label="Delete shot"
                    className="ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-noir/70 text-bone hover:bg-signal"
                  >
                    <X className="h-3 w-3" strokeWidth={1.5} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-3 max-w-[480px] text-[11px] text-ink/70">
        Tip: plain background, neutral expression, head and shoulders visible. JPG or PNG,
        under 8 MB each.
      </p>
    </section>
  );
}

/* ────────────────── Face preview: reference vs latest render ────────────────── */

interface RenderPreview {
  refUrl: string | null;
  renderUrl: string | null;
  outfitId: string | null;
  outfitName: string | null;
  generatedAt: string | null;
}

function FacePreviewSection({ userId }: { userId: string }) {
  const preview = useQuery<RenderPreview>({
    queryKey: ["face-preview", userId],
    queryFn: async () => {
      // 1. Active reference signed URL (re-uses the server fn, returns signed url)
      const refData = await listReferencePhotos();
      // 2. Latest ready render
      const { data: outfit } = await supabase
        .from("outfits")
        .select("id, name, render_path, generated_at")
        .eq("user_id", userId)
        .eq("render_status", "ready")
        .not("render_path", "is", null)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const renderUrl = outfit?.render_path
        ? supabase.storage
            .from("outfit-renders")
            .getPublicUrl(outfit.render_path).data.publicUrl
        : null;

      return {
        refUrl: refData.activeSignedUrl ?? null,
        renderUrl,
        outfitId: outfit?.id ?? null,
        outfitName: outfit?.name ?? null,
        generatedAt: outfit?.generated_at ?? null,
      };
    },
    refetchInterval: 15_000,
  });

  const data = preview.data;

  return (
    <section className="mt-12">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
        Identity preview
      </p>
      <p className="mt-2 text-[13px] text-graphite/80">
        Side-by-side of your active reference photo and your most recent generated look.
        Confirm the face matches before saving outfits.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <PreviewTile
          label="Reference"
          url={data?.refUrl ?? null}
          empty="No reference photo"
        />
        <PreviewTile
          label="Latest render"
          url={data?.renderUrl ?? null}
          empty="No render yet"
          caption={data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : undefined}
        />
      </div>
    </section>
  );
}

function PreviewTile({
  label,
  url,
  empty,
  caption,
}: {
  label: string;
  url: string | null;
  empty: string;
  caption?: string;
}) {
  return (
    <div className="flex flex-col">
      <div className="relative aspect-[3/4] overflow-hidden border border-linen bg-linen/40">
        {url ? (
          <img src={url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-4 text-center">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink/60">
              {empty}
            </span>
          </div>
        )}
      </div>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
        {label}
      </p>
      {caption && <p className="mt-0.5 text-[11px] text-ink/60">{caption}</p>}
    </div>
  );
}

/* ────────────────── Render diagnostics panel ────────────────── */

function DiagnosticsPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const health = useQuery({
    queryKey: ["reference-health"],
    queryFn: () => checkReferencePhotoHealth(),
    enabled: open,
  });

  const lastError = useQuery({
    queryKey: ["last-render-error", user?.id],
    enabled: !!user && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("outfits")
        .select("id, name, render_status, render_error, generated_at")
        .eq("user_id", user!.id)
        .not("render_error", "is", null)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
  });

  return (
    <section className="mt-12 border-t border-linen pt-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Render diagnostics
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
          {open ? "Hide" : "Show"}
        </span>
      </button>

      {open && (
        <div className="mt-5 space-y-5 rounded border border-linen bg-linen/20 p-5">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
              Reference photo
            </p>
            <button
              onClick={() => {
                qc.invalidateQueries({ queryKey: ["reference-health"] });
                qc.invalidateQueries({ queryKey: ["last-render-error", user?.id] });
              }}
              className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.18em] text-ink/70 hover:text-graphite"
            >
              <RefreshCw className="h-2.5 w-2.5" strokeWidth={1.5} />
              Re-check
            </button>
          </div>

          {health.isLoading ? (
            <p className="text-[12px] text-ink/70">Running checks…</p>
          ) : health.data ? (
            <ul className="space-y-2">
              <DiagRow
                ok={health.data.stored}
                label="Stored on profile"
                value={health.data.path ?? "— not set —"}
              />
              <DiagRow
                ok={health.data.signed_url_ok}
                label="Signed URL fetchable"
                value={
                  health.data.signed_url_ok
                    ? `HTTP ${health.data.http_status}, ${health.data.bytes ?? "?"} bytes, ${health.data.content_type ?? "unknown"}`
                    : (health.data.error ?? "unreachable")
                }
              />
            </ul>
          ) : (
            <p className="text-[12px] text-signal">Couldn't run health check.</p>
          )}

          <div className="border-t border-linen pt-4">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink">
              Last render error
            </p>
            {lastError.isLoading ? (
              <p className="mt-2 text-[12px] text-ink/70">Loading…</p>
            ) : lastError.data ? (
              <div className="mt-2 space-y-1">
                <p className="text-[12px] text-graphite">
                  {lastError.data.name ?? "(untitled look)"} ·{" "}
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/70">
                    {lastError.data.render_status}
                  </span>
                </p>
                <p className="text-[11px] text-ink/70">
                  {lastError.data.generated_at
                    ? new Date(lastError.data.generated_at).toLocaleString()
                    : ""}
                </p>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-noir/90 p-3 font-mono text-[11px] text-bone/90">
                  {lastError.data.render_error}
                </pre>
              </div>
            ) : (
              <p className="mt-2 flex items-center gap-2 text-[12px] text-graphite/80">
                <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                No render errors recorded.
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function DiagRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <li className="flex items-start gap-3">
      {ok ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-graphite" strokeWidth={1.5} />
      ) : (
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-signal" strokeWidth={1.5} />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[12px] text-graphite">{label}</p>
        <p className="break-all font-mono text-[10px] uppercase tracking-[0.14em] text-ink/70">
          {value}
        </p>
      </div>
    </li>
  );
}

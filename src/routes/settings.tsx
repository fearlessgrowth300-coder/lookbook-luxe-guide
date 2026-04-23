import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { tap } from "@/lib/motion";

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
      const { data } = await supabase.from("profiles").select("*").eq("id", user!.id).single();
      return data;
    },
  });

  const update = useMutation({
    mutationFn: async (patch: {
      style_archetype?: string;
      climate?: string;
      reference_photo_path?: string | null;
    }) => {
      const { error } = await supabase.from("profiles").update(patch).eq("id", user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["profile", user?.id] });
      toast("Saved");
    },
  });

  return (
    <Shell>
      <div className="mx-auto max-w-[680px] px-6 py-16 md:px-12">
        <h1 className="font-display text-[32px] font-light text-graphite">Settings</h1>
        <p className="mt-2 text-[14px] text-ink">{user?.email}</p>

        <ReferencePhotoSection
          userId={user!.id}
          currentPath={profile.data?.reference_photo_path ?? null}
          onChange={(path) => update.mutate({ reference_photo_path: path })}
        />

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

/* ─────────────────── Reference photo uploader ─────────────────── */

function ReferencePhotoSection({
  userId,
  currentPath,
  onChange,
}: {
  userId: string;
  currentPath: string | null;
  onChange: (path: string | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Resolve a signed URL for the current photo so we can preview it
  useEffect(() => {
    let cancelled = false;
    if (!currentPath) {
      setPreviewUrl(null);
      return;
    }
    supabase.storage
      .from("user-references")
      .createSignedUrl(currentPath, 3600)
      .then(({ data }) => {
        if (!cancelled) setPreviewUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose an image file");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error("Max 8 MB");
      return;
    }
    setBusy(true);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${userId}/reference.${ext}`;
      const { error } = await supabase.storage
        .from("user-references")
        .upload(path, file, { upsert: true, contentType: file.type, cacheControl: "3600" });
      if (error) throw error;
      onChange(path);
    } catch (err) {
      console.error(err);
      toast.error("Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    if (!currentPath) return;
    setBusy(true);
    try {
      await supabase.storage.from("user-references").remove([currentPath]);
      onChange(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-12">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
        Your reference photo
      </p>
      <p className="mt-2 text-[13px] text-graphite/80">
        Upload a clear, front-facing photo of yourself. We'll use the same face every time
        we compose a look so the model in your renders is consistently you.
      </p>

      <div className="mt-5 flex items-start gap-5">
        <div
          className="relative flex h-[140px] w-[110px] shrink-0 items-center justify-center overflow-hidden border border-linen bg-linen/40"
        >
          {previewUrl ? (
            <img
              src={previewUrl}
              alt="Reference"
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink/60">
              No photo
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
              e.target.value = "";
            }}
          />
          <motion.button
            {...tap}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-graphite px-5 text-[13px] text-bone disabled:opacity-50"
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
            {currentPath ? "Replace photo" : "Upload photo"}
          </motion.button>
          {currentPath && (
            <motion.button
              {...tap}
              onClick={handleRemove}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 px-2 font-mono text-[10px] uppercase tracking-[0.16em] text-signal hover:text-graphite"
            >
              <X className="h-3 w-3" strokeWidth={1.5} />
              Remove
            </motion.button>
          )}
          <p className="mt-1 max-w-[260px] text-[11px] text-ink/70">
            Tip: plain background, neutral expression, head and shoulders visible. JPG or
            PNG, under 8 MB.
          </p>
        </div>
      </div>
    </section>
  );
}

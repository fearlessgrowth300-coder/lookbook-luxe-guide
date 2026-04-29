// Set wizard — upload-first flow.
//
// User taps "Part of a set" → lands directly on an upload screen.
// They add each piece (agbada robe, trouser, etc.) one at a time. For each
// upload we:
//   1. Read + preview the file
//   2. Send a small JPEG to Gemini vision (analyzeWardrobeItem)
//   3. Auto-detect category, color, material, subcategory, suggested set role
//
// Once at least 2 pieces are added, the AI also infers the SET TYPE (suit,
// agbada, kaftan, tracksuit, etc.) from the combined analysis (categories +
// cultural cues in tags/material/subcategory). User can override before save.
//
// Final step: a tiny review with auto-generated set name (editable). Save
// writes garment_sets + wardrobe_items rows linked by set_id.
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState, useMemo } from "react";
import { X, Camera, Check, ArrowLeft, Plus, Sparkles, Loader2, ClipboardPaste } from "lucide-react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { prepareUploadAssets } from "@/lib/thumbnail";
import { readFileToBlob, blobToFile } from "@/lib/safe-file-read";
import { removeBg, warmBgRemoval } from "@/lib/bg-removal";
import { analyzeWardrobeItem } from "@/server/functions/analyzeItem";
import type { Category } from "@/server/mock-ai";

type SetType =
  | "suit"
  | "3piece_suit"
  | "agbada"
  | "kaftan"
  | "two_piece"
  | "tracksuit"
  | "ankara_set"
  | "other";

type SetRole =
  | "jacket"
  | "trouser"
  | "waistcoat"
  | "agbada_robe"
  | "buba_top"
  | "sokoto_trouser"
  | "kaftan_top"
  | "kaftan_bottom"
  | "tracksuit_top"
  | "tracksuit_bottom"
  | "top"
  | "bottom"
  | "overlay";

interface PieceState {
  id: string;
  file: File | null;
  previewUrl: string | null;
  status: "decoding" | "analyzing" | "ready" | "error";
  thumbDataUrl?: string;
  // AI-derived fields
  category: Category;
  subcategory: string;
  role: SetRole;
  formality: number;
  errorMsg?: string;
  aiAnalysis?: {
    color_primary: string;
    color_secondary: string | null;
    material: string;
    season: string[];
    tags: string[];
  };
}

const SET_TYPE_LABEL: Record<SetType, string> = {
  suit: "Suit",
  "3piece_suit": "Three-piece suit",
  agbada: "Agbada",
  kaftan: "Kaftan",
  two_piece: "Two-piece set",
  tracksuit: "Tracksuit",
  ankara_set: "Ankara set",
  other: "Set",
};

type Step = "upload" | "review";

export function SetWizard({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const analyze = useServerFn(analyzeWardrobeItem);

  const [step, setStep] = useState<Step>("upload");
  const [pieces, setPieces] = useState<PieceState[]>([]);
  const [setType, setSetType] = useState<SetType>("other");
  const [setTypeOverridden, setSetTypeOverridden] = useState(false);
  const [name, setName] = useState("");
  const [nameOverridden, setNameOverridden] = useState(false);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void warmBgRemoval();
  }, []);

  // Cleanup preview URLs on unmount
  useEffect(() => {
    return () => {
      pieces.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allReady = pieces.length > 0 && pieces.every((p) => p.status === "ready" || p.status === "error");
  const readyCount = pieces.filter((p) => p.status === "ready").length;

  // Auto-infer set type and name from analyzed pieces
  const { inferredType, inferredName } = useMemo(() => {
    return inferSetMeta(pieces.filter((p) => p.status === "ready"));
  }, [pieces]);

  useEffect(() => {
    if (!setTypeOverridden) setSetType(inferredType);
  }, [inferredType, setTypeOverridden]);

  useEffect(() => {
    if (!nameOverridden) setName(inferredName);
  }, [inferredName, nameOverridden]);

  const updatePiece = (id: string, patch: Partial<PieceState>) =>
    setPieces((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const removePiece = (id: string) => {
    setPieces((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const buildSmallDataUrl = async (file: File): Promise<string> => {
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return `data:${file.type || "image/jpeg"};base64,${b64}`;
    }
    const maxEdge = 512;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("canvas 2d context unavailable");
    }
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.78);
  };

  const handleFiles = async (files: FileList) => {
    const list = Array.from(files);
    for (const file of list) {
      const id = crypto.randomUUID();
      let preview: string | null = null;
      let inMemoryFile: File | null = null;
      try {
        const result = await readFileToBlob(file);
        inMemoryFile = blobToFile(result);
        preview = URL.createObjectURL(result.blob);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Couldn't read photo";
        toast.error("Skipped photo", { description: msg.slice(0, 120) });
        continue;
      }

      // Add a placeholder piece so user sees instant feedback
      setPieces((prev) => [
        ...prev,
        {
          id,
          file: inMemoryFile,
          previewUrl: preview,
          status: "decoding",
          category: "top",
          subcategory: "",
          role: "overlay",
          formality: 6,
        },
      ]);

      // Analyze in background
      void (async () => {
        try {
          const dataUrl = await buildSmallDataUrl(inMemoryFile!);
          updatePiece(id, { thumbDataUrl: dataUrl, status: "analyzing" });

          const res = await analyze({ data: { image_url: dataUrl } });
          if (!res.ok) {
            updatePiece(id, {
              status: "ready",
              subcategory: "Unidentified",
            });
            if (res.error === "rate_limited" || res.error === "payment_required") {
              toast.error(res.message);
            }
            return;
          }
          const a = res.analysis;
          updatePiece(id, {
            status: "ready",
            category: a.category as Category,
            subcategory: a.subcategory,
            formality: a.formality_score,
            role: roleFromAnalysis(a.category, a.subcategory, a.tags),
            aiAnalysis: {
              color_primary: a.color_primary,
              color_secondary: a.color_secondary,
              material: a.material,
              season: a.season,
              tags: a.tags,
            },
          });
        } catch (err) {
          console.error("[set-wizard analyze failed]", err);
          updatePiece(id, { status: "error", errorMsg: "AI analysis failed" });
        }
      })();
    }
  };

  const triggerPick = () => fileInputRef.current?.click();

  const handleSave = async () => {
    if (!user || saving) return;
    const ready = pieces.filter((p) => p.status === "ready" && p.file);
    if (ready.length === 0) {
      toast.error("Add at least one piece.");
      return;
    }
    setSaving(true);

    try {
      // Aggregate set-level info
      const formalityScores = ready.map((p) => p.formality).filter((n) => Number.isFinite(n));
      const setFormality = formalityScores.length
        ? Math.round(formalityScores.reduce((a, b) => a + b, 0) / formalityScores.length)
        : 6;

      const seasonSet = new Set<string>();
      ready.forEach((p) => p.aiAnalysis?.season.forEach((s) => seasonSet.add(s)));

      const separablePieceRoles = inferSeparable(setType, ready.map((p) => p.role));

      const { data: setRow, error: setErr } = await supabase
        .from("garment_sets" as any)
        .insert({
          user_id: user.id,
          name: name.trim() || SET_TYPE_LABEL[setType],
          set_type: setType,
          formality_score: setFormality,
          occasion_tags: [],
          must_wear_complete: separablePieceRoles.length === 0,
          separable_pieces: separablePieceRoles,
          cultural_context: defaultCulturalContext(setType),
          season: Array.from(seasonSet),
        })
        .select("id")
        .single();

      if (setErr || !setRow) throw new Error(setErr?.message ?? "Failed to create set");

      const setId = (setRow as unknown as { id: string }).id;

      const queue = [...ready];
      let successes = 0;
      const failures: string[] = [];

      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const next = queue.shift();
          if (!next) break;
          try {
            const piece = next;
            if (!piece.file) continue;

            const rawPath = `${user.id}/${piece.id}.jpg`;
            const thumbPath = `${user.id}/${piece.id}.jpg`;
            const enhancedPath = `${user.id}/${piece.id}.png`;

            const { rawBlob, thumbBlob, placeholder } = await prepareUploadAssets(
              piece.file,
              1600,
              0.9,
              0.85,
            );

            const thumbUp = await supabase.storage
              .from("wardrobe-thumbs")
              .upload(thumbPath, thumbBlob, { contentType: "image/jpeg", upsert: true });
            if (thumbUp.error) throw new Error(`thumb: ${thumbUp.error.message}`);

            const rawUp = await supabase.storage
              .from("wardrobe-raw")
              .upload(rawPath, rawBlob, { contentType: "image/jpeg", upsert: true });
            if (rawUp.error) throw new Error(`raw: ${rawUp.error.message}`);

            let enhancedPathToSave: string | null = null;
            try {
              const enhancedBlob = await removeBg(rawBlob);
              const enhancedUp = await supabase.storage
                .from("wardrobe-enhanced")
                .upload(enhancedPath, enhancedBlob, {
                  contentType: "image/png",
                  upsert: true,
                });
              if (!enhancedUp.error) enhancedPathToSave = enhancedPath;
            } catch (bgErr) {
              console.warn("[set-wizard bg-removal skipped]", bgErr);
            }

            const a = piece.aiAnalysis;
            const { error: insertErr } = await supabase.from("wardrobe_items").insert({
              id: piece.id,
              user_id: user.id,
              raw_path: rawPath,
              thumbnail_path: thumbPath,
              enhanced_path: enhancedPathToSave,
              placeholder,
              category: piece.category,
              subcategory: piece.subcategory.trim() || piece.category,
              formality_score: piece.formality,
              color_primary: a?.color_primary ?? null,
              color_secondary: a?.color_secondary ?? null,
              material: a?.material ?? null,
              season: a?.season ?? [],
              tags: a?.tags ?? [],
              set_id: setId,
              set_role: piece.role,
            } as any);
            if (insertErr) throw new Error(`insert: ${insertErr.message}`);

            successes++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : "save failed";
            failures.push(msg);
            console.error("[set-wizard save piece failed]", err);
          }
        }
      });

      await Promise.all(workers);

      qc.invalidateQueries({ queryKey: ["wardrobe", user.id] });
      qc.invalidateQueries({ queryKey: ["garment-sets", user.id] });

      if (successes === 0) {
        toast.error("No pieces saved.", { description: failures[0]?.slice(0, 120) });
        await supabase.from("garment_sets" as any).delete().eq("id", setId);
      } else {
        toast(`Saved ${name.trim() || SET_TYPE_LABEL[setType]} · ${successes} ${successes === 1 ? "piece" : "pieces"}`);
        setTimeout(() => onClose(), 600);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't save set";
      toast.error(msg.slice(0, 160));
    } finally {
      setSaving(false);
    }
  };

  const goBack = () => {
    if (step === "upload") onClose();
    else if (step === "review") setStep("upload");
  };

  const stepLabel = step === "upload" ? "1 / 2" : "2 / 2";

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.hover }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite/40"
      onClick={saving ? undefined : onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[92vh] w-full max-w-[720px] flex-col bg-bone"
        style={{ borderRadius: "4px 4px 0 0" }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*"
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              void handleFiles(e.target.files);
            }
            if (fileInputRef.current) fileInputRef.current.value = "";
          }}
        />

        {/* Header */}
        <div className="flex items-center justify-between border-b border-linen px-6 py-5">
          <button
            onClick={goBack}
            disabled={saving}
            className="flex items-center gap-2 text-ink hover:text-graphite disabled:opacity-30"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.25} />
            <span className="font-mono text-[11px] uppercase tracking-[0.16em]">Back</span>
          </button>
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">
            Step {stepLabel}
          </p>
          <button
            onClick={onClose}
            disabled={saving}
            className="text-ink hover:text-graphite disabled:opacity-30"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.25} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-8">
          <AnimatePresence mode="wait">
            {step === "upload" && (
              <motion.div
                key="upload"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  New set
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  Add the pieces
                </h2>
                <p className="mt-3 max-w-md text-[14px] text-ink">
                  Upload one photo per piece — agbada robe, trouser, jacket, etc. The AI scans
                  each photo, identifies the colour, fabric and design, and groups them as one set.
                </p>

                <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {pieces.map((piece) => (
                    <PieceTile
                      key={piece.id}
                      piece={piece}
                      onRemove={() => removePiece(piece.id)}
                    />
                  ))}

                  <motion.button
                    {...tap}
                    onClick={triggerPick}
                    className="flex aspect-[3/4] flex-col items-center justify-center gap-2 border border-dashed border-ink/40 bg-linen/30 text-ink transition-colors hover:border-graphite hover:bg-linen/50"
                  >
                    {pieces.length === 0 ? (
                      <>
                        <Camera className="h-8 w-8" strokeWidth={1.25} />
                        <span className="font-mono text-[11px] uppercase tracking-[0.16em]">
                          Upload photo
                        </span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-7 w-7" strokeWidth={1.25} />
                        <span className="font-mono text-[10px] uppercase tracking-[0.16em]">
                          Add another piece
                        </span>
                      </>
                    )}
                  </motion.button>
                </div>

                {pieces.length > 0 && allReady && readyCount > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8 flex items-start gap-3 border border-graphite/15 bg-linen/40 p-4"
                  >
                    <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-graphite" strokeWidth={1.5} />
                    <div className="flex-1">
                      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                        AI detected
                      </p>
                      <p className="mt-1 font-display text-[18px] font-light text-graphite">
                        {SET_TYPE_LABEL[inferredType]} · {inferredName}
                      </p>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}

            {step === "review" && (
              <motion.div
                key="review"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Review
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  Confirm your set
                </h2>

                <label className="mt-8 block">
                  <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                    Name
                  </span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value.slice(0, 60));
                      setNameOverridden(true);
                    }}
                    placeholder={inferredName}
                    className="mt-2 w-full border-0 border-b border-ink bg-transparent py-2 font-display text-[20px] font-light text-graphite placeholder:text-ink/40 focus:border-graphite focus:outline-none"
                  />
                </label>

                <div className="mt-8">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                    Set type
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(Object.keys(SET_TYPE_LABEL) as SetType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => {
                          setSetType(t);
                          setSetTypeOverridden(true);
                        }}
                        className={`h-8 rounded-full px-4 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                          setType === t
                            ? "bg-graphite text-bone"
                            : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                        }`}
                      >
                        {SET_TYPE_LABEL[t]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-10 grid grid-cols-3 gap-3">
                  {pieces
                    .filter((p) => p.status === "ready")
                    .map((piece) => (
                      <div key={piece.id} className="flex flex-col gap-2">
                        <div className="aspect-[3/4] bg-linen p-2">
                          {piece.previewUrl && (
                            <img
                              src={piece.previewUrl}
                              alt={piece.subcategory || piece.category}
                              className="h-full w-full object-contain"
                            />
                          )}
                        </div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
                          {piece.subcategory || piece.category}
                        </p>
                        <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink">
                          {piece.aiAnalysis?.material ?? "—"}
                        </p>
                      </div>
                    ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="border-t border-linen bg-bone px-6 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
              {step === "upload"
                ? pieces.length === 0
                  ? "Add at least 1 piece"
                  : allReady
                    ? `${readyCount} piece${readyCount === 1 ? "" : "s"} ready`
                    : "AI is analysing…"
                : `${readyCount} piece${readyCount === 1 ? "" : "s"} in this set`}
            </p>
            {step === "upload" && (
              <motion.button
                {...tap}
                onClick={() => setStep("review")}
                disabled={!allReady || readyCount === 0}
                className="flex h-12 items-center gap-2 bg-graphite px-6 font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
                style={{ letterSpacing: "0.08em" }}
              >
                Continue
              </motion.button>
            )}
            {step === "review" && (
              <motion.button
                {...tap}
                onClick={handleSave}
                disabled={saving}
                className="h-12 bg-graphite px-8 font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
                style={{ letterSpacing: "0.08em" }}
              >
                {saving ? "Saving…" : "Save set"}
              </motion.button>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ---------- Piece tile ----------
function PieceTile({ piece, onRemove }: { piece: PieceState; onRemove: () => void }) {
  const busy = piece.status === "decoding" || piece.status === "analyzing";
  return (
    <div className="flex flex-col gap-2 border border-ink/15 bg-linen/30 p-3">
      <div className="relative aspect-[3/4] w-full overflow-hidden bg-linen">
        {piece.previewUrl && (
          <img
            src={piece.previewUrl}
            alt={piece.subcategory || piece.category}
            className="h-full w-full object-contain"
          />
        )}
        {busy && (
          <div className="absolute inset-x-2 bottom-2 flex items-center justify-between border border-ink/20 bg-bone/95 px-2 py-1">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
              {piece.status === "decoding" ? "READING" : "AI SCANNING"}
            </span>
            <Loader2 className="h-3 w-3 animate-spin text-graphite" strokeWidth={1.5} />
          </div>
        )}
        {piece.status === "ready" && (
          <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-graphite text-bone">
            <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
          </div>
        )}
        {piece.status === "error" && (
          <div className="absolute inset-x-2 bottom-2 border border-noir/30 bg-bone/95 px-2 py-1">
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-noir">
              {piece.errorMsg || "Failed"}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
          {piece.status === "ready" ? piece.subcategory || piece.category : "Analysing…"}
        </span>
        <button
          onClick={onRemove}
          disabled={busy}
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink hover:text-noir disabled:opacity-30"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

// ---------- Inference helpers ----------

function roleFromAnalysis(category: string, subcategory: string, tags: string[]): SetRole {
  const text = `${subcategory} ${tags.join(" ")}`.toLowerCase();
  if (text.includes("agbada")) return "agbada_robe";
  if (text.includes("buba")) return "buba_top";
  if (text.includes("sokoto")) return "sokoto_trouser";
  if (text.includes("kaftan")) return category === "bottom" ? "kaftan_bottom" : "kaftan_top";
  if (text.includes("waistcoat") || text.includes("vest")) return "waistcoat";
  if (text.includes("blazer") || text.includes("suit jacket")) return "jacket";
  if (text.includes("tracksuit") || text.includes("track")) {
    return category === "bottom" ? "tracksuit_bottom" : "tracksuit_top";
  }
  if (category === "outerwear") return "jacket";
  if (category === "bottom") return "trouser";
  if (category === "top") return "top";
  return "overlay";
}

function inferSetMeta(ready: PieceState[]): { inferredType: SetType; inferredName: string } {
  if (ready.length === 0) return { inferredType: "other", inferredName: "" };

  const tagText = ready
    .flatMap((p) => [p.subcategory, p.aiAnalysis?.material ?? "", ...(p.aiAnalysis?.tags ?? [])])
    .join(" ")
    .toLowerCase();

  const cats = ready.map((p) => p.category);
  const has = (c: Category) => cats.includes(c);

  let type: SetType = "other";
  if (tagText.includes("agbada") || tagText.includes("buba") || tagText.includes("sokoto")) {
    type = "agbada";
  } else if (tagText.includes("kaftan")) {
    type = "kaftan";
  } else if (tagText.includes("ankara") || tagText.includes("african print")) {
    type = "ankara_set";
  } else if (tagText.includes("tracksuit") || tagText.includes("track pant") || tagText.includes("athletic")) {
    type = "tracksuit";
  } else if (
    has("outerwear") &&
    has("bottom") &&
    (tagText.includes("suit") || tagText.includes("blazer"))
  ) {
    type = ready.some((p) => /waistcoat|vest/.test(`${p.subcategory} ${p.aiAnalysis?.tags?.join(" ") ?? ""}`.toLowerCase()))
      ? "3piece_suit"
      : "suit";
  } else if (has("top") && has("bottom")) {
    type = "two_piece";
  }

  // Build a name from dominant color + type
  const primaryColor = ready.find((p) => p.aiAnalysis?.color_primary)?.aiAnalysis?.color_primary;
  const colorWord = primaryColor ? colorToWord(primaryColor) : null;
  const baseName = SET_TYPE_LABEL[type];
  const inferredName = colorWord ? `${capitalize(colorWord)} ${baseName.toLowerCase()}` : baseName;

  return { inferredType: type, inferredName };
}

function inferSeparable(setType: SetType, roles: SetRole[]): SetRole[] {
  // Conservative defaults: jackets and tops can usually be worn alone,
  // suit/agbada trousers usually can't.
  const separable: SetRole[] = [];
  for (const role of roles) {
    if (role === "jacket" && setType !== "agbada") separable.push(role);
    if (role === "buba_top") separable.push(role);
    if (role === "top" && (setType === "ankara_set" || setType === "two_piece")) separable.push(role);
    if (role === "tracksuit_top" || role === "tracksuit_bottom") separable.push(role);
  }
  return separable;
}

function defaultCulturalContext(type: SetType): string | null {
  if (type === "agbada") return "yoruba";
  if (type === "ankara_set" || type === "kaftan") return "pan_african";
  if (type === "suit" || type === "3piece_suit") return "western";
  return null;
}

function colorToWord(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max - min < 18) {
    if (lightness < 50) return "black";
    if (lightness < 110) return "charcoal";
    if (lightness < 180) return "grey";
    return "ivory";
  }
  if (r > g && r > b) return r > 180 && g < 120 ? "red" : "rust";
  if (g > r && g > b) return "olive";
  if (b > r && b > g) return b > 150 ? "blue" : "navy";
  if (r > 150 && g > 120 && b < 100) return "camel";
  return "earth";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

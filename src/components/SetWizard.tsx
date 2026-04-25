// Multi-step wizard for uploading a coordinated garment set
// (suit, agbada, kaftan, tracksuit, etc.) as a single logical unit.
//
// Flow:
//   1. Pick set type (suit / 3pc / agbada / kaftan / tracksuit / ankara / two_piece / other)
//   2. Name + occasion tags + formality
//   3. Upload each piece into its slot — full pipeline (bg removal + Gemini vision)
//   4. Mark each piece "wearable alone" or "locked to set"
//   5. Confirm — writes garment_sets row, then wardrobe_items rows linked by set_id
//
// Reuses the existing wardrobe upload pipeline so set pieces appear in the gallery
// with the same enhanced background-removed PNGs and AI-detected metadata as
// standalone items.
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { X, Camera, ImageIcon, Check, ArrowLeft, ChevronRight, Lock, Unlock } from "lucide-react";
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
  | "shirt"
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

interface SlotConfig {
  role: SetRole;
  label: string;
  /** Default category to assign to the wardrobe_items row. */
  category: Category;
  /** Default for "wearable alone" toggle. */
  defaultSeparable: boolean;
}

interface PieceState {
  /** Pre-allocated row id (becomes the wardrobe_items.id at save time). */
  id: string;
  file: File | null;
  previewUrl: string | null;
  status: "empty" | "decoding" | "analyzing" | "ready" | "error";
  thumbDataUrl?: string;
  category: Category;
  subcategory: string;
  formality: number;
  separable: boolean;
  errorMsg?: string;
  aiAnalysis?: {
    color_primary: string;
    color_secondary: string | null;
    material: string;
    season: string[];
    tags: string[];
  };
}

const SET_TYPE_OPTIONS: { id: SetType; label: string; subtitle: string }[] = [
  { id: "suit", label: "Suit", subtitle: "Jacket + trouser" },
  { id: "3piece_suit", label: "Suit (3pc)", subtitle: "Jacket + trouser + waistcoat" },
  { id: "agbada", label: "Agbada", subtitle: "Robe + buba + sokoto" },
  { id: "kaftan", label: "Kaftan", subtitle: "1- or 2-piece" },
  { id: "tracksuit", label: "Tracksuit", subtitle: "Top + bottom" },
  { id: "ankara_set", label: "Ankara set", subtitle: "Two-piece print" },
  { id: "two_piece", label: "Two-piece", subtitle: "Generic coord set" },
  { id: "other", label: "Other", subtitle: "Custom" },
];

const OCCASION_TAGS = [
  "wedding",
  "religious_ceremony",
  "formal_event",
  "office",
  "casual_outing",
  "cultural_event",
] as const;

const FORMALITY_OPTIONS: { label: string; score: number }[] = [
  { label: "Casual", score: 3 },
  { label: "Smart", score: 6 },
  { label: "Formal", score: 9 },
  { label: "Black-tie", score: 10 },
];

function defaultNameFor(type: SetType): string {
  switch (type) {
    case "suit":
      return "Navy suit";
    case "3piece_suit":
      return "Three-piece suit";
    case "agbada":
      return "Cream agbada";
    case "kaftan":
      return "Kaftan";
    case "tracksuit":
      return "Tracksuit";
    case "ankara_set":
      return "Ankara set";
    case "two_piece":
      return "Two-piece set";
    default:
      return "Set";
  }
}

function defaultFormality(type: SetType): number {
  if (type === "tracksuit") return 3;
  if (type === "two_piece" || type === "ankara_set" || type === "kaftan") return 6;
  return 9;
}

function defaultCulturalContext(type: SetType): string | null {
  if (type === "agbada") return "yoruba";
  if (type === "ankara_set") return "pan_african";
  if (type === "kaftan") return "pan_african";
  if (type === "suit" || type === "3piece_suit") return "western";
  return null;
}

function slotsFor(type: SetType, kaftanIs2pc: boolean): SlotConfig[] {
  switch (type) {
    case "suit":
      return [
        { role: "jacket", label: "Jacket", category: "outerwear", defaultSeparable: true },
        { role: "trouser", label: "Trouser", category: "bottom", defaultSeparable: false },
      ];
    case "3piece_suit":
      return [
        { role: "jacket", label: "Jacket", category: "outerwear", defaultSeparable: true },
        { role: "trouser", label: "Trouser", category: "bottom", defaultSeparable: false },
        { role: "waistcoat", label: "Waistcoat", category: "top", defaultSeparable: false },
      ];
    case "agbada":
      return [
        { role: "agbada_robe", label: "Agbada robe", category: "outerwear", defaultSeparable: false },
        { role: "buba_top", label: "Buba (top)", category: "top", defaultSeparable: true },
        { role: "sokoto_trouser", label: "Sokoto (trouser)", category: "bottom", defaultSeparable: true },
      ];
    case "kaftan":
      return kaftanIs2pc
        ? [
            { role: "kaftan_top", label: "Kaftan top", category: "top", defaultSeparable: true },
            { role: "kaftan_bottom", label: "Kaftan bottom", category: "bottom", defaultSeparable: true },
          ]
        : [{ role: "kaftan_top", label: "Kaftan", category: "top", defaultSeparable: false }];
    case "tracksuit":
      return [
        { role: "tracksuit_top", label: "Top", category: "top", defaultSeparable: true },
        { role: "tracksuit_bottom", label: "Bottom", category: "bottom", defaultSeparable: true },
      ];
    case "ankara_set":
      return [
        { role: "top", label: "Top", category: "top", defaultSeparable: true },
        { role: "bottom", label: "Bottom", category: "bottom", defaultSeparable: true },
      ];
    case "two_piece":
      return [
        { role: "top", label: "Top", category: "top", defaultSeparable: true },
        { role: "bottom", label: "Bottom", category: "bottom", defaultSeparable: true },
      ];
    default:
      return [
        { role: "overlay", label: "Piece 1", category: "top", defaultSeparable: true },
        { role: "overlay", label: "Piece 2", category: "bottom", defaultSeparable: true },
      ];
  }
}

type Step = "type" | "meta" | "kaftan_form" | "pieces" | "separability" | "confirm";

export function SetWizard({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const analyze = useServerFn(analyzeWardrobeItem);

  const [step, setStep] = useState<Step>("type");
  const [setType, setSetType] = useState<SetType | null>(null);
  const [kaftanIs2pc, setKaftanIs2pc] = useState(false);
  const [name, setName] = useState("");
  const [formality, setFormality] = useState(9);
  const [occasionTags, setOccasionTags] = useState<Set<string>>(new Set());
  const [pieces, setPieces] = useState<PieceState[]>([]);
  const [activeSlotIdx, setActiveSlotIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pre-warm bg removal as soon as we open the wizard
  useEffect(() => {
    void warmBgRemoval();
  }, []);

  // When user picks the type, seed pieces array with empty slots and advance
  useEffect(() => {
    if (!setType) return;
    if (setType === "kaftan" && step === "type") {
      setStep("kaftan_form");
      return;
    }
    const slots = slotsFor(setType, kaftanIs2pc);
    setPieces(
      slots.map((slot) => ({
        id: crypto.randomUUID(),
        file: null,
        previewUrl: null,
        status: "empty",
        category: slot.category,
        subcategory: "",
        formality: defaultFormality(setType),
        separable: slot.defaultSeparable,
      })),
    );
    setName(defaultNameFor(setType));
    setFormality(defaultFormality(setType));
    // Auto-advance from the type-picker to the meta step once a non-kaftan
    // type is chosen. Kaftan goes through the 1pc/2pc form first (handled above).
    if (step === "type" && setType !== "kaftan") {
      setStep("meta");
    }
  }, [setType, kaftanIs2pc, step]);

  // Cleanup object URLs when wizard closes
  useEffect(() => {
    return () => {
      pieces.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const slots = setType ? slotsFor(setType, kaftanIs2pc) : [];
  const filledCount = pieces.filter((p) => p.status === "ready" || p.status === "analyzing").length;

  const updatePiece = (idx: number, patch: Partial<PieceState>) =>
    setPieces((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));

  /** Build a small JPEG data URL for AI vision (max 512px edge). */
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

  const onSlotFilePicked = async (idx: number, file: File) => {
    try {
      const result = await readFileToBlob(file);
      const inMemoryFile = blobToFile(result);
      const previewUrl = URL.createObjectURL(result.blob);
      // Revoke previous preview if any
      const prev = pieces[idx];
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);

      updatePiece(idx, {
        file: inMemoryFile,
        previewUrl,
        status: "decoding",
        errorMsg: undefined,
      });

      // Run vision analysis
      try {
        const dataUrl = await buildSmallDataUrl(inMemoryFile);
        updatePiece(idx, { thumbDataUrl: dataUrl, status: "analyzing" });

        const res = await analyze({ data: { image_url: dataUrl } });
        if (!res.ok) {
          updatePiece(idx, { status: "ready" });
          if (res.error === "rate_limited" || res.error === "payment_required") {
            toast.error(res.message);
          }
          return;
        }
        const a = res.analysis;
        updatePiece(idx, {
          status: "ready",
          subcategory: a.subcategory,
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
        updatePiece(idx, { status: "ready" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't read photo";
      toast.error(`Skipped photo`, { description: msg.slice(0, 120) });
    }
  };

  const triggerSlotPick = (idx: number) => {
    setActiveSlotIdx(idx);
    fileInputRef.current?.click();
  };

  const removeSlotFile = (idx: number) => {
    const prev = pieces[idx];
    if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
    updatePiece(idx, {
      file: null,
      previewUrl: null,
      status: "empty",
      thumbDataUrl: undefined,
      aiAnalysis: undefined,
      errorMsg: undefined,
      subcategory: "",
    });
  };

  const toggleOccasion = (tag: string) => {
    setOccasionTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const canAdvanceFromMeta = name.trim().length > 0;
  const canAdvanceFromPieces = filledCount >= 1; // allow partial — user may not have all pieces

  const handleSave = async () => {
    if (!user || !setType || saving) return;

    const ready = pieces
      .map((p, i) => ({ piece: p, slot: slots[i], idx: i }))
      .filter((entry) => entry.piece.status === "ready" && entry.piece.file);

    if (ready.length === 0) {
      toast.error("Add at least one piece.");
      return;
    }

    setSaving(true);

    try {
      // 1. Insert garment_sets row first so we have its id to link pieces
      const separablePieceRoles = ready
        .filter((entry) => entry.piece.separable)
        .map((entry) => entry.slot.role);

      const { data: setRow, error: setErr } = await supabase
        .from("garment_sets" as any)
        .insert({
          user_id: user.id,
          name: name.trim(),
          set_type: setType,
          formality_score: formality,
          occasion_tags: Array.from(occasionTags),
          must_wear_complete: separablePieceRoles.length === 0,
          separable_pieces: separablePieceRoles,
          cultural_context: defaultCulturalContext(setType),
          season: [],
        })
        .select("id")
        .single();

      if (setErr || !setRow) {
        throw new Error(setErr?.message ?? "Failed to create set");
      }

      const setId = (setRow as unknown as { id: string }).id;

      // 2. Upload + insert each piece in parallel (cap concurrency at 3)
      const queue = [...ready];
      let successes = 0;
      const failures: string[] = [];

      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
          const next = queue.shift();
          if (!next) break;

          try {
            const { piece, slot } = next;
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
              subcategory: piece.subcategory.trim() || slot.label,
              formality_score: piece.formality,
              color_primary: a?.color_primary ?? null,
              color_secondary: a?.color_secondary ?? null,
              material: a?.material ?? null,
              season: a?.season ?? [],
              tags: a?.tags ?? [],
              set_id: setId,
              set_role: slot.role,
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
        toast.error("No pieces saved.", {
          description: failures[0]?.slice(0, 120),
        });
        // Roll back: delete the empty set row
        await supabase.from("garment_sets" as any).delete().eq("id", setId);
      } else {
        toast(`Saved ${name.trim()} · ${successes} ${successes === 1 ? "piece" : "pieces"}`);
        setTimeout(() => onClose(), 600);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't save set";
      toast.error(msg.slice(0, 160));
    } finally {
      setSaving(false);
    }
  };

  // Step nav helpers
  const goBack = () => {
    if (step === "type") onClose();
    else if (step === "kaftan_form") {
      setStep("type");
      setSetType(null);
    } else if (step === "meta") setStep("type");
    else if (step === "pieces") setStep("meta");
    else if (step === "separability") setStep("pieces");
    else if (step === "confirm") setStep("separability");
  };

  const stepIndex: Record<Step, number> = {
    type: 1,
    kaftan_form: 1,
    meta: 2,
    pieces: 3,
    separability: 4,
    confirm: 5,
  };
  const totalSteps = 5;

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
        {/* Hidden file input shared by all slots */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          style={{ position: "absolute", opacity: 0, pointerEvents: "none", width: 1, height: 1 }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && activeSlotIdx !== null) {
              void onSlotFilePicked(activeSlotIdx, file);
            }
            // reset so same file can be repicked
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
            Step {stepIndex[step]} / {totalSteps}
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-8">
          <AnimatePresence mode="wait">
            {step === "type" && (
              <motion.div
                key="type"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  New set
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  What kind of set?
                </h2>
                <p className="mt-3 max-w-md text-[14px] text-ink">
                  A coordinated outfit unit — the AI treats these pieces as one and won't split
                  them up unless you mark them as separable.
                </p>

                <div className="mt-8 grid grid-cols-2 gap-3">
                  {SET_TYPE_OPTIONS.map((opt) => (
                    <motion.button
                      {...tap}
                      key={opt.id}
                      onClick={() => setSetType(opt.id)}
                      className={`flex flex-col items-start gap-2 border bg-linen/30 p-5 text-left transition-colors ${
                        setType === opt.id
                          ? "border-graphite bg-linen/60"
                          : "border-ink/30 hover:border-graphite hover:bg-linen/50"
                      }`}
                    >
                      <span className="font-display text-[18px] font-light text-graphite">
                        {opt.label}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                        {opt.subtitle}
                      </span>
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}

            {step === "kaftan_form" && (
              <motion.div
                key="kaftan_form"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Kaftan
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  One-piece or two-piece?
                </h2>
                <div className="mt-8 grid grid-cols-2 gap-3">
                  <motion.button
                    {...tap}
                    onClick={() => {
                      setKaftanIs2pc(false);
                      setStep("meta");
                    }}
                    className="border border-ink/30 bg-linen/30 p-6 text-left transition-colors hover:border-graphite"
                  >
                    <span className="font-display text-[18px] font-light text-graphite">
                      One-piece
                    </span>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                      Single robe
                    </p>
                  </motion.button>
                  <motion.button
                    {...tap}
                    onClick={() => {
                      setKaftanIs2pc(true);
                      setStep("meta");
                    }}
                    className="border border-ink/30 bg-linen/30 p-6 text-left transition-colors hover:border-graphite"
                  >
                    <span className="font-display text-[18px] font-light text-graphite">
                      Two-piece
                    </span>
                    <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                      Top + bottom
                    </p>
                  </motion.button>
                </div>
              </motion.div>
            )}

            {step === "meta" && setType && (
              <motion.div
                key="meta"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Details
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  Name your set
                </h2>

                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 60))}
                  placeholder={defaultNameFor(setType)}
                  className="mt-6 w-full border-0 border-b border-ink bg-transparent py-3 font-display text-[20px] font-light text-graphite placeholder:text-ink/40 focus:border-graphite focus:outline-none"
                />

                <h3 className="mt-10 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Occasions
                </h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  {OCCASION_TAGS.map((tag) => {
                    const active = occasionTags.has(tag);
                    return (
                      <motion.button
                        {...tap}
                        key={tag}
                        onClick={() => toggleOccasion(tag)}
                        className={`h-8 rounded-full px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                          active
                            ? "bg-graphite text-bone"
                            : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                        }`}
                      >
                        {tag.replace(/_/g, " ")}
                      </motion.button>
                    );
                  })}
                </div>

                <h3 className="mt-10 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Formality
                </h3>
                <div className="mt-3 flex gap-2">
                  {FORMALITY_OPTIONS.map(({ label, score }) => (
                    <motion.button
                      {...tap}
                      key={score}
                      onClick={() => setFormality(score)}
                      className={`h-9 flex-1 rounded-full px-3 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors ${
                        formality === score
                          ? "bg-graphite text-bone"
                          : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                      }`}
                    >
                      {label}
                    </motion.button>
                  ))}
                </div>
              </motion.div>
            )}

            {step === "pieces" && setType && (
              <motion.div
                key="pieces"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  {filledCount} of {slots.length} added
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  Add the pieces of your {name.trim() || "set"}
                </h2>
                <p className="mt-3 max-w-md text-[14px] text-ink">
                  Tap a slot, take a photo or pick from gallery. AI tags each piece automatically.
                </p>

                <div
                  className="mt-8 grid gap-4"
                  style={{
                    gridTemplateColumns:
                      slots.length === 1
                        ? "1fr"
                        : slots.length === 2
                          ? "repeat(2, 1fr)"
                          : "repeat(auto-fill, minmax(180px, 1fr))",
                  }}
                >
                  {slots.map((slot, idx) => {
                    const piece = pieces[idx];
                    if (!piece) return null;
                    const busy = piece.status === "decoding" || piece.status === "analyzing";
                    return (
                      <div
                        key={`${slot.role}-${idx}`}
                        className="flex flex-col gap-2 border border-ink/15 bg-linen/30 p-3"
                      >
                        <button
                          onClick={() => triggerSlotPick(idx)}
                          disabled={busy}
                          className={`relative aspect-[3/4] w-full overflow-hidden bg-linen transition-colors ${
                            piece.status === "empty"
                              ? "border border-dashed border-ink/40 hover:border-graphite"
                              : ""
                          } ${busy ? "cursor-wait" : "cursor-pointer"}`}
                        >
                          {piece.previewUrl ? (
                            <img
                              src={piece.previewUrl}
                              alt={slot.label}
                              className="h-full w-full object-contain"
                            />
                          ) : (
                            <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-ink">
                              <Camera className="h-7 w-7" strokeWidth={1.25} />
                              <span className="font-mono text-[10px] uppercase tracking-[0.16em]">
                                Tap to add
                              </span>
                            </div>
                          )}
                          {busy && (
                            <div className="absolute inset-x-2 bottom-2 flex items-center justify-between border border-ink/20 bg-bone/95 px-2 py-1">
                              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
                                {piece.status === "decoding" ? "READING" : "AI ANALYZING"}
                              </span>
                              <motion.span
                                className="h-1.5 w-1.5 rounded-full bg-graphite"
                                animate={{ opacity: [0.3, 1, 0.3] }}
                                transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                              />
                            </div>
                          )}
                          {piece.status === "ready" && (
                            <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-graphite text-bone">
                              <Check className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </div>
                          )}
                        </button>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-graphite">
                            {slot.label}
                          </span>
                          {piece.previewUrl && piece.status !== "decoding" && piece.status !== "analyzing" && (
                            <button
                              onClick={() => removeSlotFile(idx)}
                              className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink hover:text-noir"
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <p className="mt-6 font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
                  Skip a piece if you don't have it ready — you can add it later.
                </p>
              </motion.div>
            )}

            {step === "separability" && setType && (
              <motion.div
                key="separability"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Mixing rules
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  Can any piece be worn alone?
                </h2>
                <p className="mt-3 max-w-md text-[14px] text-ink">
                  Locked pieces only appear inside this set. Separable pieces can be mixed into
                  other outfits — like a suit jacket worn with jeans.
                </p>

                <div className="mt-8 flex flex-col gap-3">
                  {slots.map((slot, idx) => {
                    const piece = pieces[idx];
                    if (!piece || piece.status !== "ready") return null;
                    return (
                      <div
                        key={`${slot.role}-${idx}`}
                        className="flex items-center gap-4 border border-ink/15 bg-linen/30 p-4"
                      >
                        {piece.previewUrl && (
                          <div className="h-16 w-16 shrink-0 bg-linen">
                            <img
                              src={piece.previewUrl}
                              alt={slot.label}
                              className="h-full w-full object-contain"
                            />
                          </div>
                        )}
                        <div className="flex-1">
                          <p className="font-display text-[16px] font-light text-graphite">
                            {slot.label}
                          </p>
                          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
                            {piece.subcategory || piece.aiAnalysis?.material || "—"}
                          </p>
                        </div>
                        <button
                          onClick={() => updatePiece(idx, { separable: !piece.separable })}
                          className={`flex items-center gap-2 rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${
                            piece.separable
                              ? "bg-graphite text-bone"
                              : "border border-ink text-ink hover:border-graphite"
                          }`}
                        >
                          {piece.separable ? (
                            <>
                              <Unlock className="h-3 w-3" strokeWidth={1.5} />
                              Wearable alone
                            </>
                          ) : (
                            <>
                              <Lock className="h-3 w-3" strokeWidth={1.5} />
                              Locked to set
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}

            {step === "confirm" && setType && (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: dur.page, ease: ease.luxury }}
              >
                <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                  Review
                </p>
                <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
                  {name.trim()}
                </h2>
                <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
                  {SET_TYPE_OPTIONS.find((s) => s.id === setType)?.label} ·{" "}
                  {FORMALITY_OPTIONS.find((f) => f.score === formality)?.label} ·{" "}
                  {pieces.filter((p) => p.status === "ready").length} pieces
                </p>

                {occasionTags.size > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {Array.from(occasionTags).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full border border-ink px-3 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-ink"
                      >
                        {tag.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-8 grid grid-cols-3 gap-3">
                  {pieces.map((piece, idx) => {
                    const slot = slots[idx];
                    if (!slot || piece.status !== "ready" || !piece.previewUrl) return null;
                    return (
                      <div key={`${slot.role}-${idx}`} className="flex flex-col gap-2">
                        <div className="aspect-[3/4] bg-linen p-2">
                          <img
                            src={piece.previewUrl}
                            alt={slot.label}
                            className="h-full w-full object-contain"
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-graphite">
                            {slot.label}
                          </span>
                          {piece.separable ? (
                            <Unlock className="h-3 w-3 text-ink" strokeWidth={1.5} />
                          ) : (
                            <Lock className="h-3 w-3 text-graphite" strokeWidth={1.5} />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <div className="border-t border-linen bg-bone px-6 py-4">
          <div className="flex items-center justify-end gap-3">
            {step === "type" && (
              <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink/60">
                Pick a type to continue
              </p>
            )}
            {step === "meta" && (
              <motion.button
                {...tap}
                onClick={() => setStep("pieces")}
                disabled={!canAdvanceFromMeta}
                className="flex h-12 items-center gap-2 bg-graphite px-6 font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
                style={{ letterSpacing: "0.08em" }}
              >
                Continue
                <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
              </motion.button>
            )}
            {step === "pieces" && (
              <motion.button
                {...tap}
                onClick={() => setStep("separability")}
                disabled={!canAdvanceFromPieces}
                className="flex h-12 items-center gap-2 bg-graphite px-6 font-mono text-[12px] uppercase text-bone hover:bg-noir disabled:opacity-30"
                style={{ letterSpacing: "0.08em" }}
              >
                Continue
                <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
              </motion.button>
            )}
            {step === "separability" && (
              <motion.button
                {...tap}
                onClick={() => setStep("confirm")}
                className="flex h-12 items-center gap-2 bg-graphite px-6 font-mono text-[12px] uppercase text-bone hover:bg-noir"
                style={{ letterSpacing: "0.08em" }}
              >
                Review
                <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
              </motion.button>
            )}
            {step === "confirm" && (
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

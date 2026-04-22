import { createFileRoute } from "@tanstack/react-router";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X, Upload as UploadIcon, Camera, ImageIcon, Check, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/Shell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { useAuth } from "@/lib/auth";
import { useUI } from "@/lib/store";
import { supabase } from "@/integrations/supabase/client";
import { ease, dur, tap } from "@/lib/motion";
import { prepareUploadAssets, type PreparationStage } from "@/lib/thumbnail";
import {
  DbInsertError,
  DecodeError,
  ThumbnailError,
  UnsupportedFormatError,
  UploadError,
} from "@/lib/upload-errors";
import {
  mockRemoveBackground,
  mockAnalyzeGarment,
  type Category,
} from "@/server/mock-ai";

export const Route = createFileRoute("/wardrobe")({
  component: () => (
    <ProtectedRoute>
      <WardrobePage />
    </ProtectedRoute>
  ),
  head: () => ({ meta: [{ title: "Wardrobe — Atelier" }] }),
});

const FILTERS: { id: Category | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "top", label: "Tops" },
  { id: "bottom", label: "Bottoms" },
  { id: "outerwear", label: "Outerwear" },
  { id: "shoes", label: "Shoes" },
  { id: "accessory", label: "Accessories" },
];

interface WardrobeItem {
  id: string;
  raw_path: string;
  enhanced_path: string | null;
  thumbnail_path: string | null;
  placeholder: string | null;
  category: Category | null;
  subcategory: string | null;
  color_primary: string | null;
  formality_score: number | null;
}

type PendingUploadStage = "decoding" | "preparing" | "uploading" | "enhancing";

interface PendingUploadItem {
  id: string;
  previewUrl: string;
  stage: PendingUploadStage;
}

const PENDING_STAGE_LABELS: Record<PendingUploadStage, string> = {
  decoding: "DECODING",
  preparing: "PREPARING",
  uploading: "UPLOADING",
  enhancing: "ENHANCING",
};

function WardrobePage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { uploadOpen, setUploadOpen, selectedItemIds, toggleSelect, clearSelection } = useUI();
  const [filter, setFilter] = useState<Category | "all">("all");
  const [pendingUpload, setPendingUpload] = useState<PendingUploadItem | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["wardrobe", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wardrobe_items")
        .select(
          "id, raw_path, enhanced_path, thumbnail_path, placeholder, category, subcategory, color_primary, formality_score",
        )
        .eq("user_id", user!.id)
        .eq("archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WardrobeItem[];
    },
  });

  // Realtime: when enhance-item completes, swap shimmer → enhanced image
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("wardrobe-updates")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "wardrobe_items",
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["wardrobe", user.id] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, qc]);

  const items = itemsQuery.data ?? [];
  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((i) => i.category === filter)),
    [items, filter],
  );
  const visibleItems = useMemo(
    () => (pendingUpload ? filtered.filter((item) => item.id !== pendingUpload.id) : filtered),
    [filtered, pendingUpload],
  );

  useEffect(() => {
    if (!pendingUpload) return;
    const matchingItem = items.find((item) => item.id === pendingUpload.id);
    if (!matchingItem) return;

    if (matchingItem.enhanced_path) {
      URL.revokeObjectURL(pendingUpload.previewUrl);
      setPendingUpload(null);
      return;
    }

    if (pendingUpload.stage !== "enhancing") {
      setPendingUpload({ ...pendingUpload, stage: "enhancing" });
    }
  }, [items, pendingUpload]);

  const categoryCount = new Set(items.map((i) => i.category).filter(Boolean)).size;

  const archiveMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("wardrobe_items")
        .update({ archived: true })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["wardrobe", user?.id] });
      clearSelection();
      toast("Archived");
    },
  });

  return (
    <Shell>
      {/* Sticky header */}
      <header className="sticky top-16 z-30 border-b border-linen bg-bone/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-6 px-6 py-6 md:px-12 md:py-8 lg:px-24">
          <div className="flex items-end justify-between gap-6">
            <div>
              <h1 className="font-display text-[28px] font-light leading-none text-graphite md:text-[32px]">
                Wardrobe
              </h1>
              <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                {items.length} ITEMS · {categoryCount} CATEGORIES
              </p>
            </div>
            <motion.button
              {...tap}
              onClick={() => setUploadOpen(true)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-ink text-graphite transition-colors hover:border-graphite hover:bg-graphite hover:text-bone"
              aria-label="Add item"
            >
              <Plus className="h-4 w-4" strokeWidth={1.5} />
            </motion.button>
          </div>

          <div className="flex flex-wrap gap-2 overflow-x-auto">
            {FILTERS.map(({ id, label }) => {
              const active = filter === id;
              return (
                <motion.button
                  {...tap}
                  key={id}
                  onClick={() => setFilter(id)}
                  className={`h-8 shrink-0 rounded-full px-4 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${
                    active
                      ? "bg-graphite text-bone"
                      : "border border-ink text-ink hover:border-graphite hover:text-graphite"
                  }`}
                >
                  {label}
                </motion.button>
              );
            })}
          </div>
        </div>
      </header>

      {/* Grid */}
      <section className="mx-auto max-w-[1280px] px-6 py-12 md:px-12 lg:px-24">
        {itemsQuery.isLoading ? (
          <Grid>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="aspect-[3/4] atelier-shimmer" />
            ))}
          </Grid>
        ) : visibleItems.length === 0 && !pendingUpload ? (
          <EmptyState onAdd={() => setUploadOpen(true)} hasItems={items.length > 0} />
        ) : (
          <AnimatePresence mode="wait">
            <motion.div
              key={filter}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: ease.tactile }}
            >
              <Grid>
                {pendingUpload && (
                  <Tile
                    key={`pending-${pendingUpload.id}`}
                    index={0}
                    pending={{ previewUrl: pendingUpload.previewUrl, label: PENDING_STAGE_LABELS[pendingUpload.stage] }}
                  />
                )}
                {visibleItems.map((item, i) => (
                  <Tile
                    key={item.id}
                    item={item}
                    index={pendingUpload ? i + 1 : i}
                    selected={selectedItemIds.has(item.id)}
                    onToggleSelect={() => toggleSelect(item.id)}
                  />
                ))}
              </Grid>
            </motion.div>
          </AnimatePresence>
        )}
      </section>

      {/* Selection action bar */}
      <AnimatePresence>
        {selectedItemIds.size > 0 && (
          <motion.div
            initial={{ y: 100 }}
            animate={{ y: 0 }}
            exit={{ y: 100 }}
            transition={{ duration: dur.page, ease: ease.luxury }}
            className="fixed bottom-16 left-0 right-0 z-40 border-t border-linen bg-bone p-4 md:bottom-0"
          >
            <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 md:px-12 lg:px-24">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
                {selectedItemIds.size} selected
              </p>
              <div className="flex gap-3">
                <button
                  onClick={clearSelection}
                  className="font-mono text-[11px] uppercase tracking-[0.16em] text-ink hover:text-graphite"
                >
                  Cancel
                </button>
                <motion.button
                  {...tap}
                  onClick={() => archiveMutation.mutate(Array.from(selectedItemIds))}
                  className="h-10 bg-graphite px-5 font-mono text-[11px] uppercase tracking-[0.16em] text-bone hover:bg-noir"
                >
                  Archive
                </motion.button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload sheet */}
      <AnimatePresence>
        {uploadOpen && (
          <UploadSheet
            onClose={() => setUploadOpen(false)}
            onPendingChange={setPendingUpload}
          />
        )}
      </AnimatePresence>
    </Shell>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
      }}
    >
      {children}
    </div>
  );
}

function Tile({
  item,
  index,
  selected,
  onToggleSelect,
  pending,
}: {
  item?: WardrobeItem;
  index: number;
  selected?: boolean;
  onToggleSelect?: () => void;
  pending?: { previewUrl: string; label: string };
}) {
  const stagger = Math.min(index, 17) * 0.035;
  const thumbUrl = item?.thumbnail_path
    ? supabase.storage.from("wardrobe-thumbs").getPublicUrl(item.thumbnail_path).data.publicUrl
    : null;
  const enhancedUrl = item?.enhanced_path
    ? supabase.storage.from("wardrobe-enhanced").getPublicUrl(item.enhanced_path).data.publicUrl
    : null;
  const [imgUrl, setImgUrl] = useState<string | null>(pending?.previewUrl ?? enhancedUrl ?? thumbUrl);

  const longPressTimer = useRef<number | null>(null);

  useEffect(() => {
    setImgUrl(pending?.previewUrl ?? enhancedUrl ?? thumbUrl);
  }, [enhancedUrl, pending?.previewUrl, thumbUrl]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: stagger, duration: dur.page, ease: ease.luxury }}
      whileHover={{ scale: 1.02, rotate: 2 }}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggleSelect?.();
      }}
      onPointerDown={() => {
        if (onToggleSelect) longPressTimer.current = window.setTimeout(onToggleSelect, 500);
      }}
      onPointerUp={() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
      }}
      onPointerLeave={() => {
        if (longPressTimer.current) clearTimeout(longPressTimer.current);
      }}
      onClick={() => {
        // Tap toggles selection if any are selected
      }}
      className={`group relative aspect-[3/4] cursor-pointer bg-linen p-3 transition-shadow ${
        selected ? "ring-1 ring-graphite ring-offset-2 ring-offset-bone" : ""
      }`}
      style={{ transitionDuration: "320ms", transitionTimingFunction: "cubic-bezier(0.16,1,0.3,1)" }}
    >
      {!imgUrl || pending ? (
        <div className="absolute inset-3 atelier-shimmer" />
      ) : item ? (
        <motion.img
          src={imgUrl}
          alt={item.subcategory || "Wardrobe item"}
          loading="lazy"
          onError={() => {
            if (imgUrl !== thumbUrl && thumbUrl) {
              setImgUrl(thumbUrl);
              return;
            }

            setImgUrl(null);
          }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.42, ease: ease.luxury }}
          className="h-full w-full object-contain"
        />
      ) : null}

      {pending && imgUrl && (
        <img src={imgUrl} alt="Uploading wardrobe item" className="h-full w-full object-contain opacity-40" />
      )}

      {pending && (
        <div className="absolute inset-x-3 bottom-3 flex items-center justify-between border border-ink/20 bg-bone/90 px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-graphite">
            {pending.label}
          </span>
          <span className="h-2 w-2 rounded-full bg-graphite" />
        </div>
      )}

      {/* Meta bar */}
      <div
        className="absolute inset-x-0 bottom-0 translate-y-full bg-bone/95 px-3 py-2 transition-transform group-hover:translate-y-0"
        style={{ transitionDuration: "220ms", transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)" }}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
              {item?.subcategory || (imgUrl ? item?.category || "—" : "Analyzing…")}
          </span>
          {item?.color_primary && (
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: item.color_primary }}
            />
          )}
        </div>
      </div>
    </motion.div>
  );
}

function EmptyState({ onAdd, hasItems }: { onAdd: () => void; hasItems: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-32 text-center">
      <h2 className="font-display text-[28px] font-light text-graphite">
        {hasItems ? "Nothing here." : "Your wardrobe starts here."}
      </h2>
      <p className="mt-3 max-w-sm text-[14px] text-ink">
        {hasItems
          ? "Try a different filter, or add a new piece."
          : "Photograph each piece against a clean background. We do the rest."}
      </p>
      <motion.button
        {...tap}
        onClick={onAdd}
        className="mt-8 h-12 bg-graphite px-8 font-mono text-[12px] uppercase tracking-[0.08em] text-bone hover:bg-noir"
      >
        Add your first piece
      </motion.button>
    </div>
  );
}

type UploadStage = "idle" | "preparing" | "uploading-thumb" | "uploading-raw" | "saving" | "enhancing" | "done";

const STAGES: { id: UploadStage; label: string }[] = [
  { id: "preparing", label: "Preparing photo" },
  { id: "uploading-thumb", label: "Uploading thumbnail" },
  { id: "uploading-raw", label: "Uploading raw image" },
  { id: "saving", label: "Saving to wardrobe" },
  { id: "enhancing", label: "Waiting for enhanced image" },
];

function UploadSheet({
  onClose,
  onPendingChange,
}: {
  onClose: () => void;
  onPendingChange: (pending: PendingUploadItem | null) => void;
}) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [dragOver, setDragOver] = useState(false);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const dropInputRef = useRef<HTMLInputElement>(null);
  const insertedItemIdRef = useRef<string | null>(null);

  const uploading = stage !== "idle" && stage !== "done";

  // Watch the wardrobe cache reactively so the sheet auto-closes when enhancement completes.
  const wardrobe = useQuery({
    queryKey: ["wardrobe", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("wardrobe_items")
        .select(
          "id, raw_path, enhanced_path, thumbnail_path, placeholder, category, subcategory, color_primary, formality_score",
        )
        .eq("user_id", user!.id)
        .eq("archived", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WardrobeItem[];
    },
  }).data;

  useEffect(() => {
    if (stage !== "enhancing" || !insertedItemIdRef.current) return;
    const item = wardrobe?.find((i) => i.id === insertedItemIdRef.current);
    if (item?.enhanced_path) {
      setStage("done");
      const t = setTimeout(() => onClose(), 700);
      return () => clearTimeout(t);
    }
  }, [wardrobe, stage, onClose]);

  // Safety net: if enhancement never reports back, auto-close after 12s anyway.
  useEffect(() => {
    if (stage !== "enhancing") return;
    const t = setTimeout(() => {
      setStage("done");
      setTimeout(() => onClose(), 600);
    }, 12000);
    return () => clearTimeout(t);
  }, [stage, onClose]);

  const resetInputs = () => {
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    if (galleryInputRef.current) galleryInputRef.current.value = "";
    if (dropInputRef.current) dropInputRef.current.value = "";
  };

  const handleFile = async (file: File) => {
    if (!user) return;
    setErrorMsg(null);
    const itemId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    onPendingChange({ id: itemId, previewUrl, stage: "decoding" });
    try {
      const rawPath = `${user.id}/${itemId}.jpg`;
      const thumbPath = `${user.id}/${itemId}.jpg`;

      setStage("preparing");
      const { rawBlob, thumbBlob, placeholder } = await prepareUploadAssets(
        file,
        1600,
        0.9,
        0.85,
        (s) => onPendingChange({ id: itemId, previewUrl, stage: s }),
      );

      setStage("uploading-thumb");
      onPendingChange({ id: itemId, previewUrl, stage: "uploading" });
      const thumbUp = await supabase.storage
        .from("wardrobe-thumbs")
        .upload(thumbPath, thumbBlob, { contentType: "image/jpeg" });
      if (thumbUp.error) throw new UploadError(thumbUp.error.message);

      setStage("uploading-raw");
      const rawUp = await supabase.storage
        .from("wardrobe-raw")
        .upload(rawPath, rawBlob, { contentType: "image/jpeg" });
      if (rawUp.error) throw new UploadError(rawUp.error.message);

      setStage("saving");
      const { error: insertErr } = await supabase.from("wardrobe_items").insert({
        id: itemId,
        user_id: user.id,
        raw_path: rawPath,
        thumbnail_path: thumbPath,
        placeholder,
      });
      if (insertErr) throw new DbInsertError(insertErr.message);

      insertedItemIdRef.current = itemId;
      qc.invalidateQueries({ queryKey: ["wardrobe", user.id] });
      toast("Added to wardrobe");

      setStage("enhancing");
      onPendingChange({ id: itemId, previewUrl, stage: "enhancing" });

      // Fire-and-forget mock enhance + analyze
      (async () => {
        try {
          const [bg, analysis] = await Promise.all([
            mockRemoveBackground({ user_id: user.id, item_id: itemId, raw_path: rawPath }),
            mockAnalyzeGarment({
              user_id: user.id,
              item_id: itemId,
              enhanced_path: `${user.id}/${itemId}.png`,
            }),
          ]);
          await supabase
            .from("wardrobe_items")
            .update({
              enhanced_path: bg.enhanced_path,
              category: analysis.category,
              subcategory: analysis.subcategory,
              color_primary: analysis.color_primary,
              color_secondary: analysis.color_secondary,
              material: analysis.material,
              season: analysis.season,
              formality_score: analysis.formality_score,
              tags: analysis.tags,
            })
            .eq("id", itemId);
          // realtime subscription will refetch and the effect above closes the sheet
        } catch (err) {
          console.error("Enhance failed", err);
        }
      })();
    } catch (e) {
      const isKnown =
        e instanceof UnsupportedFormatError ||
        e instanceof DecodeError ||
        e instanceof ThumbnailError ||
        e instanceof UploadError ||
        e instanceof DbInsertError;
      const name = isKnown && e instanceof Error ? e.name : "UploadError";
      const message = e instanceof Error ? e.message : "Upload failed";
      console.error(`[upload:${name}]`, { name: file.name, size: file.size, type: file.type }, e);
      setErrorMsg(`${name}: ${message}`);
      toast.error(`${name}: ${message}`);
      URL.revokeObjectURL(previewUrl);
      onPendingChange(null);
      setStage("idle");
      insertedItemIdRef.current = null;
    } finally {
      resetInputs();
    }
  };

  const onPickGallery = () => galleryInputRef.current?.click();
  const onPickCamera = () => cameraInputRef.current?.click();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: dur.hover }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-graphite/40"
      onClick={uploading ? undefined : onClose}
    >
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="h-[80vh] w-full max-w-[1280px] overflow-y-auto bg-bone px-6 py-8 md:px-12"
        style={{ borderRadius: "4px 4px 0 0" }}
      >
        <div className="flex items-start justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              New piece
            </p>
            <h2 className="mt-2 font-display text-[28px] font-light text-graphite">
              Add to your wardrobe
            </h2>
          </div>
          <button
            onClick={onClose}
            disabled={uploading}
            className="text-ink hover:text-graphite disabled:opacity-30"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={1.25} />
          </button>
        </div>

        {/* Hidden inputs */}
        <input
          ref={cameraInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <input
          ref={dropInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />

        {stage === "idle" && (
          <>
            <div className="mt-8 grid grid-cols-2 gap-4">
              <motion.button
                {...tap}
                onClick={onPickCamera}
                className="flex flex-col items-center justify-center gap-3 border border-ink/40 bg-linen/30 py-10 transition-colors hover:border-graphite hover:bg-linen/60"
              >
                <Camera className="h-7 w-7 text-graphite" strokeWidth={1.25} />
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  Take a photo
                </span>
              </motion.button>
              <motion.button
                {...tap}
                onClick={onPickGallery}
                className="flex flex-col items-center justify-center gap-3 border border-ink/40 bg-linen/30 py-10 transition-colors hover:border-graphite hover:bg-linen/60"
              >
                <ImageIcon className="h-7 w-7 text-graphite" strokeWidth={1.25} />
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-graphite">
                  Choose from gallery
                </span>
              </motion.button>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) handleFile(f);
              }}
              onClick={() => dropInputRef.current?.click()}
              className={`mt-6 hidden h-40 cursor-pointer flex-col items-center justify-center border border-dashed transition-colors md:flex ${
                dragOver ? "border-graphite bg-linen/40" : "border-ink/40"
              }`}
            >
              <UploadIcon className="h-6 w-6 text-ink" strokeWidth={1} />
              <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.16em] text-ink">
                Or drop an image here
              </p>
            </div>

            <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-ink">
              JPG · PNG · WEBP · HEIC · 10 MB MAX
            </p>

            {errorMsg && (
              <p className="mt-4 text-center font-mono text-[11px] text-noir">{errorMsg}</p>
            )}
          </>
        )}

        {stage !== "idle" && (
          <div className="mt-10">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
              {stage === "done" ? "Complete" : "In progress"}
            </p>
            <h3 className="mt-2 font-display text-[22px] font-light text-graphite">
              {stage === "done" ? "Your piece is ready." : "Hang tight—curating your piece."}
            </h3>

            <ol className="mt-8 space-y-4">
              {STAGES.map((s, idx) => {
                const currentIdx = STAGES.findIndex((x) => x.id === stage);
                const isDone =
                  stage === "done" || (currentIdx > -1 && idx < currentIdx);
                const isActive = s.id === stage;
                return (
                  <li key={s.id} className="flex items-center gap-4">
                    <div
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors ${
                        isDone
                          ? "border-graphite bg-graphite text-bone"
                          : isActive
                            ? "border-graphite text-graphite"
                            : "border-ink/30 text-ink/40"
                      }`}
                    >
                      {isDone ? (
                        <Check className="h-3 w-3" strokeWidth={2} />
                      ) : isActive ? (
                        <motion.span
                          className="h-1.5 w-1.5 rounded-full bg-graphite"
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                        />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-ink/30" />
                      )}
                    </div>
                    <span
                      className={`font-mono text-[12px] uppercase tracking-[0.16em] transition-colors ${
                        isDone || isActive ? "text-graphite" : "text-ink/50"
                      }`}
                    >
                      {s.label}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div className="mt-10 h-px w-full overflow-hidden bg-linen">
              <motion.div
                className="h-full bg-graphite"
                initial={{ width: "0%" }}
                animate={{
                  width: `${
                    stage === "done"
                      ? 100
                      : ((STAGES.findIndex((x) => x.id === stage) + 1) / STAGES.length) * 100
                  }%`,
                }}
                transition={{ duration: 0.5, ease: ease.luxury }}
              />
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

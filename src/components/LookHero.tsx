// Look composition view used inside the Three Looks sheet.
//
// DEFAULT: flat-lay composition — items stacked on a central vertical axis
// with side callout labels (LOOK 6 / SSENSE editorial). Cheap, instant.
//
// ON DEMAND: when the user taps "SEE ON ME" in the action row, the parent
// triggers the mannequin generation server function which caches the result
// to outfits.mannequin_path. While generating, this component shows a 15s
// shimmer overlay; on success the mannequin image fades in (420ms) over
// the flat-lay with the callout labels still visible.
import { motion, AnimatePresence } from "framer-motion";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ease } from "@/lib/motion";
import { hexToColorName } from "@/server/lib/color-names";

export interface LookHeroItem {
  id: string;
  thumbnail_path: string | null;
  enhanced_path: string | null;
  category: string | null;
  subcategory: string | null;
  color_primary: string | null;
  material: string | null;
}

export interface LookHeroOutfit {
  id: string;
  name: string | null;
  render_path: string | null;
  render_status: string | null;
  mannequin_path?: string | null;
  mannequin_status?: string | null;
}

export function LookHero({
  outfit,
  items,
  revealed = true,
  size = "md",
  mannequinLoading = false,
}: {
  outfit: LookHeroOutfit;
  items: LookHeroItem[];
  revealed?: boolean;
  size?: "md" | "lg";
  /** Parent signals an in-flight "see on me" generation. */
  mannequinLoading?: boolean;
}) {
  // Order items: outerwear → top/dress → bottom → shoes → accessories
  const ordered = useMemo(() => {
    const order = [
      "outerwear",
      "top",
      "dress",
      "bottom",
      "shoes",
      "accessory",
      "bag",
    ];
    return [...items].sort(
      (a, b) =>
        order.indexOf(a.category ?? "zzz") -
        order.indexOf(b.category ?? "zzz"),
    );
  }, [items]);

  // Split callouts left/right
  const { leftItems, rightItems } = useMemo(() => {
    const left: LookHeroItem[] = [];
    const right: LookHeroItem[] = [];
    ordered.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    return { leftItems: left, rightItems: right };
  }, [ordered]);

  // Resolve the on-demand mannequin URL (cached after first generation).
  const mannequinUrl = outfit.mannequin_path
    ? supabase.storage.from("outfit-renders").getPublicUrl(outfit.mannequin_path)
        .data.publicUrl
    : null;

  const sideW =
    size === "lg" ? "w-[82px] sm:w-[110px]" : "w-[64px] sm:w-[88px]";
  const heroFrameStyle =
    size === "lg"
      ? { minHeight: "min(90vh, 1120px)", width: "min(78vw, 1080px)" }
      : { minHeight: "min(72vh, 740px)", width: "min(72vw, 740px)" };

  return (
    <div className="relative flex h-full w-full items-stretch justify-center gap-1 sm:gap-2">
      {/* Left callouts */}
      <div className={`flex shrink-0 flex-col justify-center gap-5 sm:gap-7 ${sideW}`}>
        {leftItems.map((item, i) => (
          <CalloutLabel
            key={item.id}
            item={item}
            side="left"
            revealed={revealed}
            delay={0.2 + i * 0.1}
          />
        ))}
      </div>

      {/* Center composition */}
      <div className="relative flex flex-1 flex-col items-center justify-center">
        <div
          className="relative flex w-full flex-col items-center justify-center"
          style={heroFrameStyle}
        >
          {/* Flat-lay always rendered as base layer */}
          <FlatLay items={ordered} revealed={revealed} size={size} />

          {/* Mannequin overlay — fades in over the flat-lay when ready */}
          <AnimatePresence>
            {mannequinUrl && (
              <motion.img
                key={mannequinUrl}
                src={mannequinUrl}
                alt={outfit.name ?? "Look"}
                loading="eager"
                fetchPriority="high"
                decoding="async"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              transition={{ duration: 0.42, ease: ease.luxury }}
                className="absolute inset-0 h-full w-full object-contain"
                style={{
                  filter: "drop-shadow(0 18px 36px rgba(0,0,0,0.18))",
                }}
              />
            )}
          </AnimatePresence>

          {/* Generating shimmer — covers the composition area while waiting */}
          <AnimatePresence>
            {mannequinLoading && !mannequinUrl && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.32, ease: ease.luxury }}
                className="absolute inset-0 flex flex-col items-center justify-center"
              >
                <div
                  className="absolute inset-0"
                  style={{
                    background:
                      "linear-gradient(135deg, color-mix(in oklab, var(--linen) 92%, transparent), color-mix(in oklab, var(--bone) 60%, transparent))",
                    backdropFilter: "blur(2px)",
                  }}
                />
                <div className="atelier-shimmer absolute inset-x-8 top-1/2 h-2 -translate-y-1/2 rounded-full" />
                <p className="relative mt-4 font-mono text-[10px] uppercase tracking-[0.24em] text-graphite">
                  Composing on figure
                </p>
                <p className="relative mt-2 font-mono text-[9px] uppercase tracking-[0.22em] text-ink/60">
                  ~15 seconds
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right callouts */}
      <div className={`flex shrink-0 flex-col justify-center gap-5 sm:gap-7 ${sideW}`}>
        {rightItems.map((item, i) => (
          <CalloutLabel
            key={item.id}
            item={item}
            side="right"
            revealed={revealed}
            delay={0.25 + i * 0.1}
          />
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── Callout label ─────────────────────────── */

function CalloutLabel({
  item,
  side,
  revealed,
  delay,
}: {
  item: LookHeroItem;
  side: "left" | "right";
  revealed: boolean;
  delay: number;
}) {
  const isLeft = side === "left";
  return (
    <div
      className={`relative flex items-center ${isLeft ? "justify-end pr-3 text-right" : "justify-start pl-3 text-left"}`}
    >
      <svg
        width="28"
        height="14"
        viewBox="0 0 28 14"
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${
          isLeft ? "right-0" : "left-0"
        }`}
        aria-hidden
      >
        <motion.line
          x1={isLeft ? 28 : 0}
          y1="7"
          x2={isLeft ? 0 : 28}
          y2="7"
          stroke="var(--ink)"
          strokeWidth="1"
          strokeOpacity="0.45"
          initial={{ pathLength: 0 }}
          animate={revealed ? { pathLength: 1 } : {}}
          transition={{ duration: 0.42, ease: ease.luxury, delay }}
        />
        <motion.circle
          cx={isLeft ? 27 : 1}
          cy="7"
          r="1.5"
          fill="var(--ink)"
          initial={{ opacity: 0 }}
          animate={revealed ? { opacity: 0.55 } : {}}
          transition={{ duration: 0.3, delay: delay + 0.35 }}
        />
      </svg>

      <motion.div
        initial={{ opacity: 0, x: isLeft ? -4 : 4 }}
        animate={revealed ? { opacity: 1, x: 0 } : {}}
        transition={{ duration: 0.42, ease: ease.luxury, delay: delay + 0.25 }}
        className="max-w-full"
      >
        <p className="text-[11px] leading-tight text-graphite sm:text-[12px]">
          {(item.subcategory || item.category || "item").toLowerCase()}
        </p>
        <p className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.18em] text-ink/60 sm:text-[9px]">
          {[item.material, hexToColorName(item.color_primary)]
            .filter(Boolean)
            .join(" · ") || "—"}
        </p>
      </motion.div>
    </div>
  );
}

/* ─────────────────────────── Flat lay (default) ─────────────────────────── */

function FlatLay({
  items,
  revealed,
  size,
}: {
  items: LookHeroItem[];
  revealed: boolean;
  size: "md" | "lg";
}) {
  // Use flex-basis so items share available height instead of overflowing.
  // Cap per-item height so small wardrobes don't stretch absurdly tall.
  const itemMaxH = size === "lg" ? "max-h-[220px]" : "max-h-[160px]";
  return (
    <div className="flex h-full max-h-full w-full flex-col items-center justify-center overflow-hidden py-4">
      {items.map((item, i) => {
        const url = item.enhanced_path
          ? supabase.storage
              .from("wardrobe-enhanced")
              .getPublicUrl(item.enhanced_path).data.publicUrl
          : item.thumbnail_path
            ? supabase.storage
                .from("wardrobe-thumbs")
                .getPublicUrl(item.thumbnail_path).data.publicUrl
            : null;
        return (
          <motion.div
            key={item.id}
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={revealed ? { opacity: 1, y: 0, scale: 1 } : {}}
            transition={{
              duration: 0.5,
              ease: ease.luxury,
              delay: i * 0.1,
            }}
            className={`flex min-h-0 w-full flex-1 ${itemMaxH} -mt-2 items-center justify-center first:mt-0`}
          >
            {url ? (
              <img
                src={url}
                alt={item.subcategory ?? ""}
                loading="lazy"
                decoding="async"
                className="h-full max-h-full w-auto max-w-full object-contain"
                style={{ filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.06))" }}
              />
            ) : (
              <div className="h-full w-20 bg-bone/40" />
            )}
          </motion.div>
        );
      })}
      {/* Ground shadow */}
      <motion.div
        aria-hidden
        initial={{ opacity: 0, scaleX: 0.6 }}
        animate={revealed ? { opacity: 0.18, scaleX: 1 } : {}}
        transition={{ duration: 0.5, ease: ease.luxury, delay: 0.4 }}
        className="mt-1 h-1.5 w-[60%]"
        style={{
          background: "var(--ink)",
          borderRadius: "50%",
          filter: "blur(6px)",
        }}
      />
    </div>
  );
}

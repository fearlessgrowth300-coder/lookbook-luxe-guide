// Shared "model wearing the outfit" hero used by /today/looks and /outfit/$id.
// Renders the AI-composed model image (when ready) flanked by thin connector
// lines + labels for each item — LOOK 6 / SSENSE editorial style.
//
// While the AI render is still pending, falls back to a centered stack of the
// background-removed item PNGs and shows a "Composing on figure…" indicator.
import { motion } from "framer-motion";
import { useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { ease } from "@/lib/motion";

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
}

export function LookHero({
  outfit,
  items,
  revealed = true,
  size = "md",
}: {
  outfit: LookHeroOutfit;
  items: LookHeroItem[];
  revealed?: boolean;
  /** "md" = today/looks panel, "lg" = full outfit detail page */
  size?: "md" | "lg";
}) {
  const renderUrl = outfit.render_path
    ? supabase.storage.from("outfit-renders").getPublicUrl(outfit.render_path)
        .data.publicUrl
    : null;

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

  // Split into left/right callouts: alternate to balance both sides.
  const { leftItems, rightItems } = useMemo(() => {
    const left: LookHeroItem[] = [];
    const right: LookHeroItem[] = [];
    ordered.forEach((it, i) => {
      if (i % 2 === 0) left.push(it);
      else right.push(it);
    });
    return { leftItems: left, rightItems: right };
  }, [ordered]);

  const isRendering =
    !renderUrl &&
    (outfit.render_status === "rendering" ||
      outfit.render_status === "pending" ||
      outfit.render_status === null);
  const renderFailed = outfit.render_status === "failed";

  // Bigger render — fills the available height of its container
  const heroMaxH =
    size === "lg"
      ? "max-h-[min(90vh,1120px)]"
      : "max-h-[min(80vh,860px)]";
  const sideW =
    size === "lg" ? "w-[82px] sm:w-[110px]" : "w-[64px] sm:w-[88px]";
  const heroFrameStyle =
    size === "lg"
      ? { minHeight: "min(90vh, 1120px)", width: "min(78vw, 1080px)" }
      : { minHeight: "min(80vh, 860px)", width: "min(76vw, 860px)" };

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

      {/* Center: AI render or fallback stack */}
      <div className="relative flex flex-1 flex-col items-center justify-center">
        {renderUrl ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={revealed ? { opacity: 1, scale: 1 } : {}}
            transition={{ duration: 0.7, ease: ease.luxury }}
            className="relative flex w-full flex-col items-center justify-center"
            style={heroFrameStyle}
          >
            <img
              src={renderUrl}
              alt={outfit.name ?? "Look"}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className={`h-auto w-full max-w-full object-contain ${heroMaxH}`}
              style={{
                maxWidth: "100%",
                filter: "drop-shadow(0 18px 36px rgba(0,0,0,0.12))",
                imageRendering: "auto",
              }}
            />
            {/* Soft ground shadow */}
            <div
              aria-hidden
              className="mt-1 h-2"
              style={{
                width: "55%",
                background: "var(--ink)",
                borderRadius: "50%",
                filter: "blur(10px)",
                opacity: 0.16,
              }}
            />
          </motion.div>
        ) : (
          <FallbackStack items={ordered} revealed={revealed} size={size} />
        )}

        {isRendering && (
          <p className="mt-3 font-mono text-[9px] uppercase tracking-[0.22em] text-ink/60 sm:text-[10px]">
            Composing on figure…
          </p>
        )}
        {renderFailed && (
          <p className="mt-3 font-mono text-[9px] uppercase tracking-[0.22em] text-ink/60 sm:text-[10px]">
            Couldn't compose figure — showing items
          </p>
        )}
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
      {/* Connector line: small dot near figure → horizontal segment → label edge */}
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

      {/* Label content */}
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
          {[item.material, item.color_primary].filter(Boolean).join(" · ") ||
            "—"}
        </p>
      </motion.div>
    </div>
  );
}

/* ─────────────────────────── Fallback stack ─────────────────────────── */

function FallbackStack({
  items,
  revealed,
  size,
}: {
  items: LookHeroItem[];
  revealed: boolean;
  size: "md" | "lg";
}) {
  const itemH = size === "lg" ? "h-[210px]" : "h-[152px]";
  const frameStyle =
    size === "lg"
      ? { minHeight: "min(90vh, 1120px)", width: "min(78vw, 1080px)" }
      : { minHeight: "min(80vh, 860px)", width: "min(76vw, 860px)" };
  return (
    <div className="flex w-full flex-col items-center justify-center" style={frameStyle}>
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
            className={`flex ${itemH} -mt-3 items-center justify-center first:mt-0`}
          >
            {url ? (
              <img
                src={url}
                alt={item.subcategory ?? ""}
                className="max-h-full max-w-full object-contain"
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

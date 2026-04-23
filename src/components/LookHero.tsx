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

  const heroMaxH = size === "lg" ? "max-h-[640px]" : "max-h-[460px]";
  const sideW = size === "lg" ? "w-[110px] sm:w-[140px]" : "w-[88px] sm:w-[120px]";

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
            className="relative flex flex-col items-center"
          >
            <img
              src={renderUrl}
              alt={outfit.name ?? "Look"}
              className={`w-auto object-contain ${heroMaxH}`}
              style={{ filter: "drop-shadow(0 14px 28px rgba(0,0,0,0.10))" }}
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
  const itemH = size === "lg" ? "h-[150px]" : "h-[110px]";
  return (
    <div className="flex flex-col items-center">
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

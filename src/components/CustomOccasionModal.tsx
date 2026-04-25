import { useState } from "react";
import { motion } from "framer-motion";
import { ease, dur, tap } from "@/lib/motion";

export type CustomOccasionInput = { custom: string; note: string };

export function CustomOccasionModal({
  initialCustom,
  initialNote,
  onClose,
  onApply,
}: {
  initialCustom: string;
  initialNote: string;
  onClose: () => void;
  onApply: (input: CustomOccasionInput) => void;
}) {
  const [custom, setCustom] = useState(initialCustom);
  const [note, setNote] = useState(initialNote);
  const canApply = custom.trim().length > 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: dur.hover, ease: ease.tactile }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-graphite/40 px-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: dur.page, ease: ease.luxury }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] bg-bone p-10"
        style={{ boxShadow: "0 20px 60px -20px rgba(0,0,0,0.25)", borderRadius: "2px" }}
      >
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink">
          Custom occasion
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-graphite/80">
          Tell the stylist where you're going and any context that matters.
        </p>

        <div className="mt-6 space-y-4">
          <div>
            <label
              htmlFor="custom-occ"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink"
            >
              Occasion
            </label>
            <input
              id="custom-occ"
              autoFocus
              type="text"
              value={custom}
              maxLength={80}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="e.g. Job interview at a startup"
              className="mt-2 h-11 w-full border border-ink bg-transparent px-3 text-[14px] text-graphite placeholder:text-ink/40 focus:border-graphite focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="custom-note"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink"
            >
              Notes <span className="text-ink/50">(optional)</span>
            </label>
            <textarea
              id="custom-note"
              value={note}
              maxLength={400}
              rows={3}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Dress code, vibe, who you're meeting, weather, anything to know…"
              className="mt-2 w-full resize-none border border-ink bg-transparent p-3 text-[13px] leading-relaxed text-graphite placeholder:text-ink/40 focus:border-graphite focus:outline-none"
            />
            <p className="mt-1 text-right font-mono text-[10px] text-ink/50">
              {note.length}/400
            </p>
          </div>
        </div>

        <div className="mt-8 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="h-11 px-5 font-mono text-[11px] uppercase tracking-[0.16em] text-ink hover:text-graphite"
          >
            Cancel
          </button>
          <motion.button
            {...tap}
            onClick={() => canApply && onApply({ custom, note })}
            disabled={!canApply}
            className="h-11 bg-graphite px-6 text-[13px] text-bone disabled:opacity-40"
          >
            Apply
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

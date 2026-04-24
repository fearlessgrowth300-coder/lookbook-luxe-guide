// Ambient cycling fashion backdrop for the Today page.
//
// Behaviour:
// - Mounts a fixed full-viewport layer behind page content.
// - Crossfades between mood images every 7s.
// - Respects prefers-reduced-motion: locks to a static image.
// - Gracefully handles missing image files: if /mood/*.jpg returns 404 the
//   image simply stays hidden and the dark overlay still produces a
//   deliberate "noir mood" rather than a broken layout.
// - Manifest-driven: just drop new files into /public/mood/ named
//   mood-01.jpg ... mood-10.jpg and they appear automatically.

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const MOOD_IMAGES = [
  "/mood/mood-01.jpg",
  "/mood/mood-02.jpg",
  "/mood/mood-03.jpg",
  "/mood/mood-04.jpg",
  "/mood/mood-05.jpg",
  "/mood/mood-06.jpg",
  "/mood/mood-07.jpg",
  "/mood/mood-08.jpg",
  "/mood/mood-09.jpg",
  "/mood/mood-10.jpg",
];

const CYCLE_MS = 7000;
const FADE_MS = 1400;

export function AmbientBackdrop() {
  const [available, setAvailable] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);

  // Probe each image once. Files that 404 are excluded silently; the rest
  // become the active rotation.
  useEffect(() => {
    let cancelled = false;
    const probes = MOOD_IMAGES.map(
      (src) =>
        new Promise<string | null>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(src);
          img.onerror = () => resolve(null);
          img.src = src;
        }),
    );
    Promise.all(probes).then((results) => {
      if (cancelled) return;
      const found = results.filter((s): s is string => s !== null);
      setAvailable(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reduced motion preference
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.("change", handler);
    return () => mq.removeEventListener?.("change", handler);
  }, []);

  // Cycle index
  useEffect(() => {
    if (reducedMotion || available.length <= 1) return;
    const t = setInterval(() => {
      setIndex((i) => (i + 1) % available.length);
    }, CYCLE_MS);
    return () => clearInterval(t);
  }, [reducedMotion, available.length]);

  const currentSrc = available[index] ?? null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-noir"
      style={{ contain: "strict" }}
    >
      {/* Cycling image layer. When no images exist, the noir bg shows through
          the (intentional) dark mood. */}
      <AnimatePresence mode="sync">
        {currentSrc && (
          <motion.div
            key={currentSrc}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: FADE_MS / 1000, ease: [0.4, 0, 0.2, 1] }}
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: `url('${currentSrc}')` }}
          />
        )}
      </AnimatePresence>

      {/* Dark overlay — guarantees light text remains readable across any
          backdrop image (or against pure noir when no images present). */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(20,20,22,0.72) 0%, rgba(20,20,22,0.62) 50%, rgba(20,20,22,0.92) 100%)",
        }}
      />

      {/* Bottom fade-out so the rest of the page (Recent looks etc.) returns
          to bone smoothly. */}
      <div
        className="absolute inset-x-0 bottom-0 h-[40vh]"
        style={{
          background:
            "linear-gradient(180deg, rgba(245,241,234,0) 0%, var(--bone) 100%)",
        }}
      />
    </div>
  );
}

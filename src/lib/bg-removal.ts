/**
 * Client-side background removal via @imgly/background-removal.
 *
 * Runs entirely in the browser (WASM). The first call downloads ~15MB of
 * model + WASM assets, which are cached in IndexedDB by the library — every
 * subsequent call is fast and offline-capable.
 *
 * We intentionally use the smaller `isnet_quint8` model: ~5x faster than the
 * default and good enough for clothing on a clean background.
 */

let preloadPromise: Promise<void> | null = null;
let removeFnPromise: Promise<typeof import("@imgly/background-removal")> | null = null;

function loadModule() {
  if (!removeFnPromise) {
    removeFnPromise = import("@imgly/background-removal");
  }
  return removeFnPromise;
}

const MODEL: "isnet_quint8" = "isnet_quint8";

/**
 * Pre-fetch the model + WASM so the user's first real upload doesn't pay the
 * download cost. Safe to call repeatedly — only the first call does work.
 *
 * Call this from the authenticated app shell on mount, non-blocking.
 */
export async function warmBgRemoval(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  if (typeof window === "undefined") return;
  preloadPromise = (async () => {
    try {
      const mod = await loadModule();
      // preload may not be exported in every version; fall back to a no-op.
      const preload = (mod as { preload?: (cfg: unknown) => Promise<void> }).preload;
      if (typeof preload === "function") {
        await preload({ model: MODEL });
      }
    } catch (err) {
      // Pre-warming failures are non-fatal — actual removeBg call will retry.
      console.warn("[bg-removal] preload failed", err);
      preloadPromise = null;
    }
  })();
  return preloadPromise;
}

export interface BgRemovalProgress {
  step: string;
  progress: number; // 0..1
}

/**
 * Strip the background from a garment photo, returning a transparent PNG.
 * Throws on failure — caller should handle by skipping the enhanced upload
 * (we still have the raw + thumb).
 */
export async function removeBg(
  input: Blob,
  onProgress?: (progress: BgRemovalProgress) => void,
): Promise<Blob> {
  const mod = await loadModule();
  const result = await mod.removeBackground(input, {
    model: MODEL,
    output: { format: "image/png", quality: 0.85 },
    progress: onProgress
      ? (key: string, current: number, total: number) => {
          const progress = total > 0 ? current / total : 0;
          onProgress({ step: key, progress });
        }
      : undefined,
  });
  return result;
}

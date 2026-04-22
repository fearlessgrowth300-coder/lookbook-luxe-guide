import { DecodeError, ThumbnailError, UnsupportedFormatError } from "@/lib/upload-errors";

type Heic2AnyFn = (opts: {
  blob: Blob;
  toType?: string;
  quality?: number;
}) => Promise<Blob | Blob[]>;

let heic2anyPromise: Promise<Heic2AnyFn> | null = null;

async function loadHeic2Any(): Promise<Heic2AnyFn> {
  if (typeof window === "undefined") {
    throw new DecodeError("HEIC conversion is only available in the browser.", "HEIC CONVERT FAILED");
  }
  if (!heic2anyPromise) {
    heic2anyPromise = import("heic2any").then((m) => (m.default ?? m) as Heic2AnyFn);
  }
  return heic2anyPromise;
}

type DecodedImage = {
  file: File;
  source: CanvasImageSource;
  width: number;
  height: number;
  wasHeicConversion: boolean;
  decodeMethod: string;
  dispose: () => void;
};

type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "heif" | "avif" | "unknown";
export type PreparationStage = "decoding" | "preparing";

export type PipelineEvent = {
  step: string;
  detail?: string;
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DECODED_MEMORY_BYTES = 100 * 1024 * 1024; // ~RGBA footprint cap
const MAX_LONGEST_EDGE = 2000; // pre-scale ceiling for low-end mobile
const THUMB_BACKGROUND = "#F5F1EA";

async function sniffImageFormat(file: Blob): Promise<ImageFormat> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder("ascii").decode(bytes);

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";

  // ISO BMFF box: bytes 4-8 = "ftyp", bytes 8-12 = brand
  const boxType = ascii.slice(4, 8).toLowerCase();
  if (boxType === "ftyp") {
    const brand = ascii.slice(8, 12).toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "heic";
    if (["heif", "heim", "heis", "hevm", "hevs"].includes(brand)) return "heif";
    if (brand === "avif") return "avif";
  }

  return "unknown";
}

function hasHeicExtension(fileName: string) {
  return /\.(heic|heif)$/i.test(fileName);
}

function hasSupportedExtension(fileName: string) {
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName);
}

function renameHeicFile(fileName: string) {
  const renamed = fileName.replace(/\.hei[cf]$/i, ".jpg");
  return renamed && renamed !== fileName ? renamed : "upload.jpg";
}

async function isHeic(file: File): Promise<boolean> {
  if (file.type === "image/heic" || file.type === "image/heif") return true;
  if (hasHeicExtension(file.name)) return true;
  const sniffed = await sniffImageFormat(file);
  return sniffed === "heic" || sniffed === "heif";
}

async function normalizeInputFile(
  file: File,
  emit?: (event: PipelineEvent) => void,
): Promise<{ file: File; wasHeicConversion: boolean }> {
  const sniffedFormat = await sniffImageFormat(file);
  const lowerName = file.name.toLowerCase();
  const hintedHeic = await isHeic(file);

  // file.type is "" on some iOS versions — fall back to extension + sniff
  const looksLikeImage =
    file.type.startsWith("image/") ||
    hasSupportedExtension(lowerName) ||
    (sniffedFormat !== "unknown" && sniffedFormat !== "gif" && sniffedFormat !== "avif");

  if (!looksLikeImage) {
    throw new UnsupportedFormatError(
      "Unsupported image format. Use JPG, PNG, WEBP, or HEIC.",
      "FORMAT REJECTED",
    );
  }

  if (!hintedHeic) return { file, wasHeicConversion: false };

  emit?.({ step: "heic detected", detail: `${file.type || "type:?"} · ${sniffedFormat}` });

  try {
    const heic2any = await loadHeic2Any();
    const converted = await heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.9,
    });
    const convertedBlob = Array.isArray(converted) ? converted[0] : converted;

    if (!(convertedBlob instanceof Blob)) {
      throw new Error("HEIC conversion did not return a blob");
    }

    const out = new File([convertedBlob], renameHeicFile(lowerName), { type: "image/jpeg" });
    emit?.({
      step: "heic converted",
      detail: `${(convertedBlob.size / 1024 / 1024).toFixed(2)}MB JPEG`,
    });
    return { file: out, wasHeicConversion: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown";
    throw new DecodeError(`HEIC → JPEG failed: ${message}`, "HEIC CONVERT FAILED");
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new ThumbnailError("Canvas produced no blob.", "CANVAS ENCODE FAILED"));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });
}

async function decodeViaImageBitmapOriented(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
}

async function decodeViaImageBitmapPlain(file: File): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
}

async function decodeViaObjectUrl(file: File): Promise<{ image: HTMLImageElement; revoke: () => void } | null> {
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      try {
        await img.decode?.();
      } catch {
        // ignore — drawImage still works on most browsers
      }
      resolve({ image: img, revoke: () => URL.revokeObjectURL(url) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function decodeViaFileReader(file: File): Promise<HTMLImageElement | null> {
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const dataUrl = reader.result;
      if (typeof dataUrl !== "string") {
        resolve(null);
        return;
      }
      const img = new Image();
      img.decoding = "async";
      img.onload = async () => {
        try {
          await img.decode?.();
        } catch {
          // ignore
        }
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

async function decodeImageSource(
  file: File,
  onStageChange?: (stage: PreparationStage) => void,
  emit?: (event: PipelineEvent) => void,
): Promise<DecodedImage> {
  onStageChange?.("decoding");

  const normalized = await normalizeInputFile(file, emit);
  const attempts: string[] = [];

  // Attempt 1: createImageBitmap with EXIF orientation
  const oriented = await decodeViaImageBitmapOriented(normalized.file);
  if (oriented && oriented.width > 0 && oriented.height > 0) {
    emit?.({
      step: "decoded",
      detail: `${oriented.width}x${oriented.height} via createImageBitmap(oriented)`,
    });
    return {
      file: normalized.file,
      source: oriented,
      width: oriented.width,
      height: oriented.height,
      wasHeicConversion: normalized.wasHeicConversion,
      decodeMethod: "createImageBitmap(oriented)",
      dispose: () => oriented.close?.(),
    };
  }
  attempts.push("createImageBitmap(oriented)");
  oriented?.close?.();

  // Attempt 2: createImageBitmap plain
  const plain = await decodeViaImageBitmapPlain(normalized.file);
  if (plain && plain.width > 0 && plain.height > 0) {
    emit?.({
      step: "decoded",
      detail: `${plain.width}x${plain.height} via createImageBitmap`,
    });
    return {
      file: normalized.file,
      source: plain,
      width: plain.width,
      height: plain.height,
      wasHeicConversion: normalized.wasHeicConversion,
      decodeMethod: "createImageBitmap",
      dispose: () => plain.close?.(),
    };
  }
  attempts.push("createImageBitmap");
  plain?.close?.();

  // Attempt 3: HTMLImageElement via object URL
  const objUrl = await decodeViaObjectUrl(normalized.file);
  if (objUrl) {
    const w = objUrl.image.naturalWidth || objUrl.image.width;
    const h = objUrl.image.naturalHeight || objUrl.image.height;
    if (w > 0 && h > 0) {
      emit?.({ step: "decoded", detail: `${w}x${h} via Image+ObjectURL` });
      return {
        file: normalized.file,
        source: objUrl.image,
        width: w,
        height: h,
        wasHeicConversion: normalized.wasHeicConversion,
        decodeMethod: "Image+ObjectURL",
        dispose: objUrl.revoke,
      };
    }
    objUrl.revoke();
  }
  attempts.push("Image+ObjectURL");

  // Attempt 4: FileReader → dataURL → Image
  const reader = await decodeViaFileReader(normalized.file);
  if (reader) {
    const w = reader.naturalWidth || reader.width;
    const h = reader.naturalHeight || reader.height;
    if (w > 0 && h > 0) {
      emit?.({ step: "decoded", detail: `${w}x${h} via FileReader+dataURL` });
      return {
        file: normalized.file,
        source: reader,
        width: w,
        height: h,
        wasHeicConversion: normalized.wasHeicConversion,
        decodeMethod: "FileReader+dataURL",
        dispose: () => {
          /* nothing to revoke */
        },
      };
    }
  }
  attempts.push("FileReader+dataURL");

  throw new DecodeError(
    `All decode strategies failed (${attempts.join(", ")}).`,
    "DECODE FAILED",
  );
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ThumbnailError("Canvas 2D context unavailable.", "CANVAS CONTEXT MISSING");

  return { canvas, ctx };
}

/**
 * Iteratively halve the image down to within one halving of the target,
 * then do a final scaled draw. This keeps peak memory low on mobile —
 * never holding more than ~4x the downscaled size at once.
 */
function iterativeHalveDown(
  source: CanvasImageSource,
  width: number,
  height: number,
  targetLongest: number,
  emit?: (event: PipelineEvent) => void,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  let currentSrc: CanvasImageSource = source;
  let curW = width;
  let curH = height;
  let lastCanvas: HTMLCanvasElement | null = null;

  // Halve until next halving would dip below target
  while (Math.max(curW, curH) > targetLongest * 2) {
    const nextW = Math.max(1, Math.floor(curW / 2));
    const nextH = Math.max(1, Math.floor(curH / 2));
    try {
      const { canvas, ctx } = createCanvas(nextW, nextH);
      ctx.drawImage(currentSrc, 0, 0, nextW, nextH);
      lastCanvas = canvas;
      currentSrc = canvas;
      curW = nextW;
      curH = nextH;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown";
      throw new ThumbnailError(`Halving step failed at ${nextW}x${nextH}: ${message}`, "CANVAS OOM");
    }
  }

  // Final scale to fit target
  const scale = Math.min(1, targetLongest / Math.max(curW, curH));
  const finalW = Math.max(1, Math.round(curW * scale));
  const finalH = Math.max(1, Math.round(curH * scale));

  try {
    const { canvas, ctx } = createCanvas(finalW, finalH);
    ctx.drawImage(currentSrc, 0, 0, finalW, finalH);
    emit?.({ step: "scaled", detail: `${finalW}x${finalH} (target ${targetLongest}px)` });
    return { canvas, width: finalW, height: finalH };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown";
    throw new ThumbnailError(
      `Final downscale failed at ${finalW}x${finalH}: ${message}`,
      "CANVAS OOM",
    );
  } finally {
    // We intentionally keep lastCanvas around because it's the final source.
    // No leak — GC reclaims when references drop.
    void lastCanvas;
  }
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
  background?: string,
): HTMLCanvasElement {
  const scale = Math.min(targetWidth / width, targetHeight / height);
  const drawWidth = Math.max(1, Math.round(width * scale));
  const drawHeight = Math.max(1, Math.round(height * scale));
  const dx = Math.round((targetWidth - drawWidth) / 2);
  const dy = Math.round((targetHeight - drawHeight) / 2);
  const { canvas, ctx } = createCanvas(targetWidth, targetHeight);

  try {
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, targetWidth, targetHeight);
    }
    ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
    return canvas;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown";
    throw new ThumbnailError(
      `drawImage failed at ${targetWidth}x${targetHeight}: ${message}`,
      "CANVAS DRAW FAILED",
    );
  }
}

export async function prepareUploadAssets(
  file: File,
  maxEdge = 1600,
  rawQuality = 0.9,
  thumbQuality = 0.85,
  onStageChange?: (stage: PreparationStage) => void,
  emit?: (event: PipelineEvent) => void,
): Promise<{
  rawBlob: Blob;
  thumbBlob: Blob;
  placeholder: string;
  wasHeicConversion: boolean;
  decodeMethod: string;
}> {
  emit?.({
    step: "picked file",
    detail: `${(file.size / 1024 / 1024).toFixed(2)}MB · ${file.type || "type:?"} · ${file.name}`,
  });

  // Memory pressure guard — RGBA after decode is ~4x the file size for
  // compressed formats; refuse anything that would blow past 100MB.
  const projectedDecoded = file.size * 4;
  if (projectedDecoded > MAX_DECODED_MEMORY_BYTES) {
    throw new UnsupportedFormatError(
      "This image is too large for mobile. Try a smaller photo or reduce resolution in your camera app.",
      "MEMORY GUARD",
    );
  }

  const decoded = await decodeImageSource(file, onStageChange, emit);

  try {
    onStageChange?.("preparing");

    // 1. Pre-scale to a sane working size (capped at MAX_LONGEST_EDGE)
    const longestEdge = Math.max(decoded.width, decoded.height);
    const workingTarget = Math.min(MAX_LONGEST_EDGE, Math.max(decoded.width, decoded.height));
    const halved =
      longestEdge > MAX_LONGEST_EDGE
        ? iterativeHalveDown(decoded.source, decoded.width, decoded.height, workingTarget, emit)
        : null;

    const workingSource: CanvasImageSource = halved?.canvas ?? decoded.source;
    const workingW = halved?.width ?? decoded.width;
    const workingH = halved?.height ?? decoded.height;

    // 2. Final downscale for the raw upload (capped at maxEdge or working size)
    const rawLongest = Math.min(maxEdge, Math.max(workingW, workingH));
    const rawScale = Math.min(1, rawLongest / Math.max(workingW, workingH));
    const rawW = Math.max(1, Math.round(workingW * rawScale));
    const rawH = Math.max(1, Math.round(workingH * rawScale));

    const { canvas: rawCanvas } = createCanvas(rawW, rawH);
    const rawCtx = rawCanvas.getContext("2d");
    if (!rawCtx) throw new ThumbnailError("Canvas 2D context unavailable.", "CANVAS CONTEXT MISSING");
    try {
      rawCtx.drawImage(workingSource, 0, 0, rawW, rawH);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown";
      throw new ThumbnailError(
        `Raw drawImage failed at ${rawW}x${rawH}: ${message}`,
        "CANVAS OOM",
      );
    }

    // 3. Thumbnail + placeholder come off the working source (already small)
    const thumbCanvas = drawScaled(workingSource, workingW, workingH, 400, 400, THUMB_BACKGROUND);
    const placeholderCanvas = drawScaled(workingSource, workingW, workingH, 16, 16, THUMB_BACKGROUND);

    const [rawBlob, thumbBlob] = await Promise.all([
      canvasToBlob(rawCanvas, "image/jpeg", rawQuality),
      canvasToBlob(thumbCanvas, "image/jpeg", thumbQuality),
    ]);

    emit?.({
      step: "thumbnail",
      detail: `400x400 (${(thumbBlob.size / 1024).toFixed(0)}KB)`,
    });
    emit?.({
      step: "raw ready",
      detail: `${rawW}x${rawH} (${(rawBlob.size / 1024 / 1024).toFixed(2)}MB)`,
    });

    if (rawBlob.size > MAX_UPLOAD_BYTES) {
      throw new UnsupportedFormatError(
        "This photo is still larger than 10 MB after preparation. Try a smaller image.",
        "OVER 10MB",
      );
    }

    return {
      rawBlob,
      thumbBlob,
      placeholder: placeholderCanvas.toDataURL("image/jpeg", 0.4),
      wasHeicConversion: decoded.wasHeicConversion,
      decodeMethod: decoded.decodeMethod,
    };
  } finally {
    decoded.dispose();
  }
}

export async function generateThumbnail(file: File): Promise<Blob> {
  return (await prepareUploadAssets(file)).thumbBlob;
}

export async function downscaleForUpload(file: File, maxEdge = 1600, quality = 0.9): Promise<Blob> {
  return (await prepareUploadAssets(file, maxEdge, quality)).rawBlob;
}

export async function generatePlaceholder(file: File): Promise<string> {
  return (await prepareUploadAssets(file)).placeholder;
}

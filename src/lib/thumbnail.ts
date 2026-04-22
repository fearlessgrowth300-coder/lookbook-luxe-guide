import { DecodeError, ThumbnailError, UnsupportedFormatError } from "@/lib/upload-errors";

type Heic2AnyFn = (opts: {
  blob: Blob;
  toType?: string;
  quality?: number;
}) => Promise<Blob | Blob[]>;

let heic2anyPromise: Promise<Heic2AnyFn> | null = null;

async function loadHeic2Any(): Promise<Heic2AnyFn> {
  if (typeof window === "undefined") {
    throw new DecodeError("HEIC conversion is only available in the browser.");
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
  dispose: () => void;
};

type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "heif" | "avif" | "unknown";
export type PreparationStage = "decoding" | "preparing";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const THUMB_BACKGROUND = "#F5F1EA";

async function sniffImageFormat(file: Blob): Promise<ImageFormat> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder("ascii").decode(bytes);

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";

  const brand = ascii.slice(8, 12).toLowerCase();
  if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "heic";
  if (["heif", "heim", "heis", "hevm", "hevs"].includes(brand)) return "heif";
  if (brand === "avif") return "avif";

  return "unknown";
}

function hasSupportedExtension(fileName: string) {
  return /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName);
}

function renameHeicFile(fileName: string) {
  return fileName.replace(/\.hei[cf]$/i, ".jpg") || "upload.jpg";
}

async function normalizeInputFile(file: File): Promise<{ file: File; wasHeicConversion: boolean }> {
  const sniffedFormat = await sniffImageFormat(file);
  const lowerName = file.name.toLowerCase();
  const hintedHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif") ||
    sniffedFormat === "heic" ||
    sniffedFormat === "heif";

  const looksLikeImage = file.type.startsWith("image/") || hasSupportedExtension(lowerName) || sniffedFormat !== "unknown";
  if (!looksLikeImage) {
    throw new UnsupportedFormatError("Unsupported image format. Use JPG, PNG, WEBP, or HEIC.");
  }

  if (!hintedHeic) return { file, wasHeicConversion: false };

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

    return {
      file: new File([convertedBlob], renameHeicFile(lowerName), { type: "image/jpeg" }),
      wasHeicConversion: true,
    };
  } catch {
    throw new DecodeError("Couldn't decode this HEIC — try saving as JPEG.");
  }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new ThumbnailError("Couldn't generate the image preview for upload."));
        return;
      }
      resolve(blob);
    }, type, quality);
  });
}

async function loadHtmlImage(objectUrl: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      try {
        await img.decode?.();
      } catch {
        // drawImage fallback still works on some mobile browsers.
      }
      resolve(img);
    };
    img.onerror = () => reject(new DecodeError("This photo could not be decoded on your device."));
    img.src = objectUrl;
  });
}

async function decodeImageSource(
  file: File,
  onStageChange?: (stage: PreparationStage) => void,
): Promise<DecodedImage> {
  onStageChange?.("decoding");

  const normalized = await normalizeInputFile(file);

  try {
    const bitmap = await createImageBitmap(normalized.file);
    if (bitmap.width > 0 && bitmap.height > 0) {
      return {
        file: normalized.file,
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        wasHeicConversion: normalized.wasHeicConversion,
        dispose: () => bitmap.close?.(),
      };
    }
    bitmap.close?.();
  } catch {
    // Fallback below.
  }

  const objectUrl = URL.createObjectURL(normalized.file);
  try {
    const image = await loadHtmlImage(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (width > 0 && height > 0) {
      return {
        file: normalized.file,
        source: image,
        width,
        height,
        wasHeicConversion: normalized.wasHeicConversion,
        dispose: () => URL.revokeObjectURL(objectUrl),
      };
    }
  } catch {
    URL.revokeObjectURL(objectUrl);
  }

  throw new DecodeError(
    normalized.wasHeicConversion
      ? "Couldn't decode this HEIC — try saving as JPEG."
      : "This photo could not be prepared on your device yet. Try a JPG, PNG, WEBP, or HEIC photo.",
  );
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ThumbnailError("Canvas 2D context unavailable.");

  return { canvas, ctx };
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
  } catch {
    throw new ThumbnailError("This photo loaded, but your browser could not draw it for upload.");
  }
}

function drawResized(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const { canvas, ctx } = createCanvas(width, height);

  try {
    ctx.drawImage(source, 0, 0, width, height);
    return canvas;
  } catch {
    throw new ThumbnailError("This photo loaded, but your browser could not prepare it for upload.");
  }
}

export async function prepareUploadAssets(
  file: File,
  maxEdge = 1600,
  rawQuality = 0.9,
  thumbQuality = 0.85,
  onStageChange?: (stage: PreparationStage) => void,
): Promise<{ rawBlob: Blob; thumbBlob: Blob; placeholder: string; wasHeicConversion: boolean }> {
  const decoded = await decodeImageSource(file, onStageChange);

  try {
    onStageChange?.("preparing");

    const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
    const rawWidth = Math.max(1, Math.round(decoded.width * scale));
    const rawHeight = Math.max(1, Math.round(decoded.height * scale));

    const rawCanvas = drawResized(decoded.source, rawWidth, rawHeight);
    const thumbCanvas = drawScaled(decoded.source, decoded.width, decoded.height, 400, 400, THUMB_BACKGROUND);
    const placeholderCanvas = drawScaled(decoded.source, decoded.width, decoded.height, 16, 16, THUMB_BACKGROUND);

    const [rawBlob, thumbBlob] = await Promise.all([
      canvasToBlob(rawCanvas, "image/jpeg", rawQuality),
      canvasToBlob(thumbCanvas, "image/jpeg", thumbQuality),
    ]);

    if (rawBlob.size > MAX_UPLOAD_BYTES) {
      throw new UnsupportedFormatError("This photo is still larger than 10 MB after preparation. Try a smaller image.");
    }

    return {
      rawBlob,
      thumbBlob,
      placeholder: placeholderCanvas.toDataURL("image/jpeg", 0.4),
      wasHeicConversion: decoded.wasHeicConversion,
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

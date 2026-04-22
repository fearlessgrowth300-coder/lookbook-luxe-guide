import { heicTo, isHeic } from "heic-to/csp";

/**
 * Client-side image preparation helpers.
 *
 * Mobile browsers can fail or flake when we call createImageBitmap(file)
 * multiple times on the same large photo. Decode once, then reuse the same
 * source for raw upload, thumbnail generation, and placeholder creation.
 */

type DecodedImage = {
  source: CanvasImageSource;
  width: number;
  height: number;
  dispose: () => void;
};

type ImageFormat = "jpeg" | "png" | "webp" | "gif" | "heic" | "heif" | "avif" | "unknown";

async function sniffImageFormat(file: Blob): Promise<ImageFormat> {
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const ascii = new TextDecoder("ascii").decode(bytes);

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";

  const brand = ascii.slice(8, 12).toLowerCase();
  if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "heic";
  if (["heif", "heim", "heis", "hevm", "hevs"].includes(brand)) return "heif";
  if (brand === "avif") return "avif";

  return "unknown";
}

async function normalizeInputFile(file: File): Promise<File | Blob> {
  const lowerName = file.name.toLowerCase();
  const hintedHeic =
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif");
  const sniffedFormat = await sniffImageFormat(file);
  const shouldConvert = hintedHeic || sniffedFormat === "heic" || sniffedFormat === "heif";

  if (!shouldConvert) return file;

  const confirmedHeic = await isHeic(file).catch(() => sniffedFormat === "heic" || sniffedFormat === "heif");
  if (!confirmedHeic) return file;

  try {
    const converted = await heicTo({
      blob: file,
      type: "image/jpeg",
      quality: 0.92,
    });

    return converted instanceof Blob
      ? new File([converted], lowerName.replace(/\.hei[cf]$/i, ".jpg") || "upload.jpg", {
          type: "image/jpeg",
        })
      : file;
  } catch {
    throw new Error(
      "Your gallery photo format is not supported by this browser yet. Please pick a JPG/PNG photo or take a new photo now.",
    );
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Image decode failed"));
    };
    reader.onerror = () => reject(new Error("Image decode failed"));
    reader.readAsDataURL(blob);
  });
}

async function blobToChunkedDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }

  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode image"))),
      type,
      quality,
    );
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Image decode failed"));
    };
    reader.onerror = () => reject(new Error("Image decode failed"));
    reader.readAsDataURL(file);
  });
}

async function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = async () => {
      try {
        await img.decode?.();
      } catch {
        // Some mobile browsers fire onload but reject decode(); drawImage still works.
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error("Image decode failed"));
    img.src = src;
  });
}

async function decodeImageSource(file: File): Promise<DecodedImage> {
  const normalizedFile = await normalizeInputFile(file);
  const objectUrl = URL.createObjectURL(normalizedFile);

  try {
    const image = await loadHtmlImage(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (width > 0 && height > 0) {
      return {
        source: image,
        width,
        height,
        dispose: () => URL.revokeObjectURL(objectUrl),
      };
    }
  } catch {
    URL.revokeObjectURL(objectUrl);
  }

  try {
    const image = await loadHtmlImage(await blobToDataUrl(normalizedFile));
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (width > 0 && height > 0) {
      return {
        source: image,
        width,
        height,
        dispose: () => undefined,
      };
    }
  } catch {
    try {
      const image = await loadHtmlImage(await blobToChunkedDataUrl(normalizedFile));
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;

      if (width > 0 && height > 0) {
        return {
          source: image,
          width,
          height,
          dispose: () => undefined,
        };
      }
    } catch {
      // Fall through to ImageBitmap decode as a final fallback.
    }
  }

  try {
    const bitmap = await createImageBitmap(normalizedFile);
    if (bitmap.width > 0 && bitmap.height > 0) {
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        dispose: () => bitmap.close?.(),
      };
    }
    bitmap.close?.();
  } catch {
    // Final error below.
  }

  throw new Error(
    "This photo could not be prepared on your device yet. Take it with your camera or choose it from your gallery and try again.",
  );
}

function drawContained(
  source: CanvasImageSource,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement {
  const scale = Math.min(targetWidth / width, targetHeight / height);
  const drawWidth = Math.round(width * scale);
  const drawHeight = Math.round(height * scale);
  const dx = Math.round((targetWidth - drawWidth) / 2);
  const dy = Math.round((targetHeight - drawHeight) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  try {
    ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
    return canvas;
  } catch {
    throw new Error(
      "This photo loaded, but your browser could not draw it for upload. Try taking it again or pick it from your gallery.",
    );
  }
}

function drawCenteredCrop(
  source: CanvasImageSource,
  width: number,
  height: number,
  size: number,
): HTMLCanvasElement {
  const side = Math.min(width, height);
  const sx = (width - side) / 2;
  const sy = (height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  try {
    ctx.fillStyle = "#EAE4D9";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);
  } catch {
    throw new Error(
      "This photo loaded, but your browser could not crop it for upload. Try taking it again or pick it from your gallery.",
    );
  }

  return canvas;
}

/**
 * Prepare all upload assets from a single decode pass.
 */
export async function prepareUploadAssets(
  file: File,
  maxEdge = 1600,
  rawQuality = 0.9,
  thumbQuality = 0.85,
): Promise<{ rawBlob: Blob; thumbBlob: Blob; placeholder: string }> {
  const decoded = await decodeImageSource(file);

  try {
    const scale = Math.min(1, maxEdge / Math.max(decoded.width, decoded.height));
    const rawWidth = Math.max(1, Math.round(decoded.width * scale));
    const rawHeight = Math.max(1, Math.round(decoded.height * scale));

    const rawCanvas = drawContained(
      decoded.source,
      decoded.width,
      decoded.height,
      rawWidth,
      rawHeight,
    );
    const thumbCanvas = drawCenteredCrop(decoded.source, decoded.width, decoded.height, 400);
    const placeholderCanvas = drawContained(decoded.source, decoded.width, decoded.height, 16, 16);

    const [rawBlob, thumbBlob] = await Promise.all([
      canvasToBlob(rawCanvas, "image/jpeg", rawQuality),
      canvasToBlob(thumbCanvas, "image/jpeg", thumbQuality),
    ]);

    return {
      rawBlob,
      thumbBlob,
      placeholder: placeholderCanvas.toDataURL("image/jpeg", 0.4),
    };
  } finally {
    decoded.dispose();
  }
}

export async function generateThumbnail(file: File): Promise<Blob> {
  return (await prepareUploadAssets(file)).thumbBlob;
}

export async function downscaleForUpload(
  file: File,
  maxEdge = 1600,
  quality = 0.9,
): Promise<Blob> {
  return (await prepareUploadAssets(file, maxEdge, quality)).rawBlob;
}

/** Tiny base64 LQIP for blurhash-like placeholder. */
export async function generatePlaceholder(file: File): Promise<string> {
  return (await prepareUploadAssets(file)).placeholder;
}

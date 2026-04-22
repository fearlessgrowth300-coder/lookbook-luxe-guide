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

async function decodeImageSource(file: File): Promise<DecodedImage> {
  try {
    const bitmap = await createImageBitmap(file);
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
    // Fall through to HTMLImageElement decode, which is more reliable on some mobile browsers.
  }

  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = objectUrl;
    });

    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;

    if (!width || !height) {
      throw new Error("Image decode failed");
    }

    return {
      source: image,
      width,
      height,
      dispose: () => URL.revokeObjectURL(objectUrl),
    };
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error(
      "This photo could not be decoded on your device. Try a JPG or PNG from your gallery.",
    );
  }
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

  ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
  return canvas;
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

  ctx.fillStyle = "#EAE4D9";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(source, sx, sy, side, side, 0, 0, size, size);

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

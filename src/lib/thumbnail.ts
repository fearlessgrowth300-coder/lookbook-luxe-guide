/**
 * Client-side thumbnail generation via Canvas.
 * 400×400 centered crop, JPEG quality 0.85.
 */
export async function generateThumbnail(file: File): Promise<Blob> {
  const SIZE = 400;
  const QUALITY = 0.85;

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const side = Math.min(width, height);
  const sx = (width - side) / 2;
  const sy = (height - side) / 2;

  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Fill with linen so transparent originals look intentional.
  ctx.fillStyle = "#EAE4D9";
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
  bitmap.close?.();

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      QUALITY,
    );
  });
}

/** Tiny base64 LQIP for blurhash-like placeholder. */
export async function generatePlaceholder(file: File): Promise<string> {
  const SIZE = 16;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.4);
}

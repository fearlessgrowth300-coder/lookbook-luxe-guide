export class UnsupportedFormatError extends Error {
  step = "FORMAT REJECTED";
  constructor(message: string, step?: string) {
    super(message);
    this.name = "UnsupportedFormatError";
    if (step) this.step = step;
  }
}

export class DecodeError extends Error {
  step = "DECODE FAILED";
  constructor(message: string, step?: string) {
    super(message);
    this.name = "DecodeError";
    if (step) this.step = step;
  }
}

export class ThumbnailError extends Error {
  step = "THUMBNAIL FAILED";
  constructor(message: string, step?: string) {
    super(message);
    this.name = "ThumbnailError";
    if (step) this.step = step;
  }
}

export class UploadError extends Error {
  step = "UPLOAD FAILED";
  constructor(message: string, step?: string) {
    super(message);
    this.name = "UploadError";
    if (step) this.step = step;
  }
}

export class DbInsertError extends Error {
  step = "DB INSERT FAILED";
  constructor(message: string, step?: string) {
    super(message);
    this.name = "DbInsertError";
    if (step) this.step = step;
  }
}

export function getStep(error: unknown, fallback = "UNKNOWN STEP"): string {
  if (error && typeof error === "object" && "step" in error) {
    const step = (error as { step?: unknown }).step;
    if (typeof step === "string") return step;
  }
  return fallback;
}

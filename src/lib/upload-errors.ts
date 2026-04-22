export class UnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedFormatError";
  }
}

export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecodeError";
  }
}

export class ThumbnailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThumbnailError";
  }
}

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export class DbInsertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbInsertError";
  }
}
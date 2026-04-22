/**
 * Safe file read for mobile browsers.
 *
 * Android Brave/Chrome (and sometimes iOS Safari) revoke the file handle
 * between the moment <input type="file"> resolves and the moment we actually
 * try to read its bytes. The result is the dreaded:
 *
 *   NotReadableError: The requested file could not be read, typically due
 *   to permission problems that have occurred after a reference to the
 *   file was acquired.
 *
 * The fix is to drain the file into an in-memory ArrayBuffer the instant
 * onChange fires, then operate on a synthetic Blob from then on. The
 * original File can be discarded.
 *
 * Returns an in-memory Blob that mirrors the original file's bytes and
 * MIME type. From this point forward, every step (preview, HEIC convert,
 * canvas decode, thumbnail, upload) reads from this Blob — not the File.
 */

import { DecodeError } from "@/lib/upload-errors";

const ARRAY_BUFFER_TIMEOUT_MS = 15_000;

function inferMimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return "application/octet-stream";
}

function readViaFileReader(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(result);
      } else {
        reject(new DecodeError("FileReader returned a non-ArrayBuffer result.", "FILEREADER WRONG TYPE"));
      }
    };
    reader.onerror = () => {
      const err = reader.error;
      reject(
        new DecodeError(
          `FileReader failed: ${err?.name ?? "unknown"}: ${err?.message ?? "no message"}`,
          "FILEREADER FAILED",
        ),
      );
    };
    try {
      reader.readAsArrayBuffer(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown";
      reject(new DecodeError(`FileReader threw synchronously: ${message}`, "FILEREADER FAILED"));
    }
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DecodeError(`${label} timed out after ${ms}ms`, "READ TIMEOUT"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export type SafeReadResult = {
  blob: Blob;
  byteLength: number;
  mimeType: string;
  fileName: string;
  method: "arrayBuffer" | "FileReader";
};

export type SafeReadEvent = { step: string; detail?: string };

/**
 * Drain a File into an in-memory Blob. Try file.arrayBuffer() first with
 * a 15s timeout; if that hangs or throws, fall back to FileReader which
 * has more reliable behavior on iOS for very large HEIC files.
 *
 * Throws DecodeError with a clear step name on failure. Callers should
 * surface a friendly "couldn't read this photo" message — don't blame
 * the user, this is a browser quirk.
 */
export async function readFileToBlob(
  file: File,
  emit?: (event: SafeReadEvent) => void,
): Promise<SafeReadResult> {
  const inferredType = file.type || inferMimeFromName(file.name);

  emit?.({
    step: "picked file",
    detail: `${file.name} · ${file.type || "type:?"} · ${(file.size / 1024 / 1024).toFixed(2)}MB`,
  });

  let buffer: ArrayBuffer;
  let method: SafeReadResult["method"] = "arrayBuffer";

  try {
    if (typeof file.arrayBuffer === "function") {
      buffer = await withTimeout(file.arrayBuffer(), ARRAY_BUFFER_TIMEOUT_MS, "file.arrayBuffer()");
      emit?.({ step: "arrayBuffer read OK", detail: `${buffer.byteLength} bytes` });
    } else {
      // Very old browsers — go straight to FileReader.
      buffer = await readViaFileReader(file);
      method = "FileReader";
      emit?.({ step: "arrayBuffer read OK", detail: `${buffer.byteLength} bytes (FileReader)` });
    }
  } catch (primaryErr) {
    const primaryName = primaryErr instanceof Error ? primaryErr.name : "Unknown";
    const primaryMsg = primaryErr instanceof Error ? primaryErr.message : "Unknown";
    emit?.({ step: "arrayBuffer failed", detail: `${primaryName}: ${primaryMsg} — falling back to FileReader` });

    try {
      buffer = await readViaFileReader(file);
      method = "FileReader";
      emit?.({ step: "FileReader read OK", detail: `${buffer.byteLength} bytes` });
    } catch (fallbackErr) {
      const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : "Unknown";
      // Permission revoked between pick and read — Android Brave/Chrome quirk.
      throw new DecodeError(
        `Could not read file bytes. Primary: ${primaryMsg}. Fallback: ${fallbackMsg}`,
        "FILE UNREADABLE",
      );
    }
  }

  const blob = new Blob([buffer], { type: inferredType });
  emit?.({
    step: "blob created",
    detail: `${blob.type || "type:?"} · ${blob.size} bytes · via ${method}`,
  });

  return {
    blob,
    byteLength: buffer.byteLength,
    mimeType: inferredType,
    fileName: file.name,
    method,
  };
}

/**
 * Wrap an in-memory Blob back into a File so downstream code that expects
 * `File` (with .name) still works. The bytes are the in-memory copy — the
 * original OS file handle is no longer involved.
 */
export function blobToFile(result: SafeReadResult): File {
  return new File([result.blob], result.fileName || "upload", {
    type: result.mimeType,
  });
}

// Image generation/editing via the Lovable AI Gateway (Nano Banana models).
// Server-only.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface ImageGenContent {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ImageGenOptions {
  /** "google/gemini-2.5-flash-image" (Nano Banana) or "google/gemini-3.1-flash-image-preview" (Nano Banana 2). */
  model?: string;
  /** A single composite user message. Mix text and image_url parts. */
  parts: ImageGenContent[];
  timeoutMs?: number;
}

export class ImageGenError extends Error {
  status: number;
  code: "rate_limited" | "payment_required" | "no_image" | "timeout" | "unknown";
  constructor(message: string, status: number, code: ImageGenError["code"] = "unknown") {
    super(message);
    this.name = "ImageGenError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Generate or edit an image. Returns the raw data URL ("data:image/png;base64,...").
 */
export async function generateImage(opts: ImageGenOptions): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 90_000,
  );

  let resp: Response;
  try {
    resp = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model ?? "google/gemini-2.5-flash-image",
        messages: [{ role: "user", content: opts.parts }],
        modalities: ["image", "text"],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new ImageGenError("Image gen timed out", 504, "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 429) {
    throw new ImageGenError("Rate limited", 429, "rate_limited");
  }
  if (resp.status === 402) {
    throw new ImageGenError("Credits exhausted", 402, "payment_required");
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new ImageGenError(
      `Image gen error ${resp.status}: ${body.slice(0, 300)}`,
      resp.status,
    );
  }

  const json = (await resp.json()) as {
    choices?: Array<{
      message?: {
        images?: Array<{ image_url?: { url?: string } }>;
      };
    }>;
  };

  const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) {
    throw new ImageGenError("No image returned by model", 500, "no_image");
  }
  return url;
}

/** Convert a `data:image/...;base64,...` URL to a Uint8Array + content type. */
export function dataUrlToBytes(
  dataUrl: string,
): { bytes: Uint8Array; contentType: string } {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw new Error("Invalid data URL");
  const contentType = match[1];
  const base64 = match[2];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, contentType };
}

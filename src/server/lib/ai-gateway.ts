// Thin wrapper around the Lovable AI Gateway (OpenAI-compatible).
// Server-only — never import in client code.
//
// We intentionally don't use the OpenAI SDK so we have full control over
// errors, JSON-mode, and to keep the Worker bundle small.

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  /** Max tokens in the assistant response. */
  max_tokens?: number;
  /** Forces the model to return a JSON object. */
  json?: boolean;
  /** Hard timeout in ms (default 30s for chat, callers can extend). */
  timeoutMs?: number;
}

export class AIGatewayError extends Error {
  status: number;
  code: "rate_limited" | "payment_required" | "bad_response" | "timeout" | "unknown";
  constructor(
    message: string,
    status: number,
    code: AIGatewayError["code"] = "unknown",
  ) {
    super(message);
    this.name = "AIGatewayError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Non-streaming chat completion. Returns the assistant's text content.
 */
export async function chatCompletion(
  opts: ChatCompletionOptions,
): Promise<string> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) throw new Error("LOVABLE_API_KEY not configured");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
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
        model: opts.model,
        messages: opts.messages,
        ...(opts.temperature !== undefined && { temperature: opts.temperature }),
        ...(opts.max_tokens !== undefined && { max_completion_tokens: opts.max_tokens }),
        ...(opts.json && { response_format: { type: "json_object" } }),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new AIGatewayError("AI request timed out", 504, "timeout");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (resp.status === 429) {
    throw new AIGatewayError(
      "AI gateway rate limit exceeded",
      429,
      "rate_limited",
    );
  }
  if (resp.status === 402) {
    throw new AIGatewayError(
      "AI credits exhausted",
      402,
      "payment_required",
    );
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new AIGatewayError(
      `AI gateway error ${resp.status}: ${body.slice(0, 300)}`,
      resp.status,
    );
  }

  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new AIGatewayError(
      "AI gateway returned no content",
      500,
      "bad_response",
    );
  }
  return content;
}

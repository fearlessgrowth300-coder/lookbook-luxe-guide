// Server-side rate limiting helper.
//
// Calls the `increment_ai_usage` Postgres function which atomically increments
// the per-user, per-day counter for the given AI function and enforces the
// daily limit. Throws a `RateLimitError` when the user has exceeded their
// allotment so the caller can short-circuit BEFORE making any paid AI call.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type AiFunctionName =
  | "suggestOutfit"
  | "visionAnalyzeItem"
  | "generateDailyPrompt";

export class RateLimitError extends Error {
  code = "rate_limited" as const;
  limit: number;
  count: number;
  fn: AiFunctionName;
  constructor(fn: AiFunctionName, count: number, limit: number) {
    super(`rate_limited: ${fn} ${count}/${limit}`);
    this.name = "RateLimitError";
    this.fn = fn;
    this.count = count;
    this.limit = limit;
  }
}

interface IncrementResult {
  ok: boolean;
  count: number;
  limit: number;
}

export async function checkAndIncrement(
  supabase: SupabaseClient<Database>,
  userId: string,
  fn: AiFunctionName,
  limit: number,
): Promise<{ count: number; limit: number }> {
  const today = new Date().toISOString().slice(0, 10);
  // The RPC isn't in the generated types yet — cast through unknown.
  const { data, error } = await (
    supabase.rpc as unknown as (
      name: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: IncrementResult | null; error: unknown }>
  )("increment_ai_usage", {
    u: userId,
    f: fn,
    d: today,
    l: limit,
  });

  if (error) throw error;
  if (!data) throw new Error("rate_limit_rpc_returned_null");
  if (!data.ok) throw new RateLimitError(fn, data.count, data.limit);
  return { count: data.count, limit: data.limit };
}

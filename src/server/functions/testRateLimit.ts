// TEMPORARY test server function for verifying the rate-limit infrastructure.
// Calls checkAndIncrement against the suggestOutfit bucket with a *low* test
// limit (2) so we can confirm the third call is blocked.
//
// Remove this file (and the test button in /today) once Step 7 is verified.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkAndIncrement, RateLimitError } from "@/server/lib/rate-limit";

export const testRateLimit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    try {
      const result = await checkAndIncrement(
        supabase,
        userId,
        "suggestOutfit",
        2, // intentionally low limit for the test
      );
      return { ok: true as const, ...result };
    } catch (err) {
      if (err instanceof RateLimitError) {
        return {
          ok: false as const,
          error: "rate_limited" as const,
          count: err.count,
          limit: err.limit,
        };
      }
      throw err;
    }
  });

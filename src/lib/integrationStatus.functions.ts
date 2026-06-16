import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Reports whether optional third-party integration keys are configured
 * on the server. NEVER returns the secret values themselves — only a
 * boolean presence flag and a short non-sensitive preview (last 4 chars).
 */
export const getIntegrationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const apifyKey = process.env.APIFY_API_KEY ?? "";
    const lovableKey = process.env.LOVABLE_API_KEY ?? "";

    return {
      apify: {
        configured: apifyKey.length > 0,
        // Safe hint so the user can verify they pasted the right key
        // without exposing the full secret.
        hint: apifyKey.length > 4 ? `••••${apifyKey.slice(-4)}` : null,
      },
      lovableAi: {
        configured: lovableKey.length > 0,
      },
    };
  });

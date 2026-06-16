// Daily editorial prompt generator.
//
// Caches one prompt per user per day in `daily_prompts`. If a prompt already
// exists for today, returns it immediately (no AI call, no rate-limit hit).
// Otherwise: fetch weather → call GPT-5-mini with editorial voice → store.
//
// Rate limit: 3/day per user (caching means normal usage hits this once).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkAndIncrement, RateLimitError } from "@/server/lib/rate-limit";
import { chatCompletion, AIGatewayError } from "@/server/lib/ai-gateway";

interface PromptInput {
  lat?: number;
  lon?: number;
}

// Open-Meteo WMO weather code → short human label.
function weatherCodeToText(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  if (code <= 99) return "thunderstorm";
  return "overcast";
}

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
  };
}

async function fetchWeather(
  lat: number,
  lon: number,
): Promise<{ temp_c: number; condition: string }> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`;
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`weather_${resp.status}`);
    const json = (await resp.json()) as OpenMeteoResponse;
    const temp = json.current?.temperature_2m;
    const code = json.current?.weather_code ?? 3;
    if (typeof temp !== "number") throw new Error("weather_no_temp");
    return { temp_c: Math.round(temp), condition: weatherCodeToText(code) };
  } finally {
    clearTimeout(timeout);
  }
}

export const generateDailyPrompt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: PromptInput) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const today = new Date().toISOString().slice(0, 10);

    // Check cache first — common case, never hits AI or rate limit.
    const { data: existing } = await supabase
      .from("daily_prompts")
      .select("*")
      .eq("user_id", userId)
      .eq("prompt_date", today)
      .maybeSingle();
    if (existing) return { ok: true as const, prompt: existing };

    // Rate limit BEFORE AI call.
    try {
      await checkAndIncrement(supabase, userId, "generateDailyPrompt", 3);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return {
          error: "rate_limited" as const,
          count: err.count,
          limit: err.limit,
        };
      }
      throw err;
    }

    // Weather: try Open-Meteo if we have coords; otherwise neutral defaults.
    let temp_c = 15;
    let condition = "overcast";
    if (typeof data.lat === "number" && typeof data.lon === "number") {
      try {
        const w = await fetchWeather(data.lat, data.lon);
        temp_c = w.temp_c;
        condition = w.condition;
      } catch (err) {
        console.warn("[daily-prompt] weather fetch failed", err);
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("style_archetype")
      .eq("id", userId)
      .maybeSingle();
    const archetype = profile?.style_archetype ?? "classic";

    const dayOfWeek = new Date().toLocaleDateString("en-US", {
      weekday: "long",
    });

    let promptText: string;
    try {
      const raw = await chatCompletion({
        model: "openai/gpt-5-mini",
        timeoutMs: 20_000,
        messages: [
          {
            role: "system",
            content:
              'Write ONE editorial styling prompt. Under 18 words. SSENSE editorial voice. Reference the weather or day subtly. Never use "perfect", "stylish", "chic", "effortless", "timeless". No emoji. No exclamation. No quotes in your output.',
          },
          {
            role: "user",
            content: `Archetype: ${archetype}. Weather: ${temp_c}°C, ${condition}. Day: ${dayOfWeek}.
Examples of tone (do not copy verbatim):
- A 14° overcast Tuesday calls for unstructured tailoring — something you can walk the long way home in.
- Warm enough for linen. Cool enough to keep the jacket close.
- Something soft against something structured — that's the only rule today.
Return only the prompt text.`,
          },
        ],
      });
      promptText = raw.trim().replace(/^["']|["']$/g, "");
    } catch (err) {
      if (err instanceof AIGatewayError && err.code === "payment_required") {
        return {
          error: "ai_unavailable" as const,
          code: err.code,
          message: "AI credits exhausted on the workspace.",
        };
      }
      console.error("[daily-prompt] AI call failed", err);
      return {
        error: "ai_unavailable" as const,
        code: "unknown" as const,
        message: "Couldn't generate today's prompt.",
      };
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("daily_prompts")
      .insert({
        user_id: userId,
        prompt_date: today,
        prompt_text: promptText,
        context: {
          temp_c,
          condition,
          day_of_week: dayOfWeek,
          archetype,
          lat: data.lat ?? null,
          lon: data.lon ?? null,
        },
      })
      .select()
      .single();
    if (insertErr) throw insertErr;

    return { ok: true as const, prompt: inserted };
  });

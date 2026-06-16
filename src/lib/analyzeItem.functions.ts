// Real AI vision analysis for a wardrobe garment.
//
// Accepts a publicly-fetchable image URL (the freshly-uploaded raw file in
// wardrobe-raw, signed) OR a base64 data URL, and returns a structured
// garment analysis matching the GarmentAnalysis shape used by the gallery.
//
// Rate-limited to 100 calls/user/day (covers a fairly large bulk import).
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const InputSchema = z.object({
  /** A data URL (data:image/...;base64,...) OR an https URL the model can fetch. */
  image_url: z.string().min(10).max(20_000_000),
});

const CATEGORIES = ["top", "bottom", "outerwear", "dress", "shoes", "accessory", "bag"] as const;
const SEASONS = ["spring", "summer", "fall", "winter"] as const;

export interface AnalyzeResult {
  category: (typeof CATEGORIES)[number];
  subcategory: string;
  color_primary: string;
  color_secondary: string | null;
  material: string;
  season: (typeof SEASONS)[number][];
  formality_score: number;
  tags: string[];
}

const SYSTEM = `You are a fashion stylist analyzing a single garment photo.
Return STRICT JSON only, no prose. Schema:
{
  "category": one of "top" | "bottom" | "outerwear" | "dress" | "shoes" | "accessory" | "bag",
  "subcategory": short noun phrase, max 3 words, lowercase (e.g. "oxford shirt", "wool trousers", "leather loafer"),
  "color_primary": CSS hex like "#1C1C1C",
  "color_secondary": hex or null,
  "material": short phrase (e.g. "cotton poplin", "wool flannel"),
  "season": array of any of "spring","summer","fall","winter",
  "formality_score": integer 1-10 (1=athletic, 5=casual, 7=smart, 9=formal),
  "tags": array of 2-6 short adjectives (lowercase, single word preferred)
}
Rules:
- "category" must reflect the dominant garment in frame.
- Never invent text — base every field on what is visible.
- Prefer specific subcategory ("oxford shirt") over generic ("shirt").`;

export const analyzeWardrobeItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => InputSchema.parse(input))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    try {
      await checkAndIncrement(supabase, userId, "visionAnalyzeItem", 100);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return {
          ok: false as const,
          error: "rate_limited" as const,
          message: `Daily AI limit reached (${err.limit}). Try again tomorrow.`,
        };
      }
      throw err;
    }

    let raw: string;
    try {
      raw = await chatCompletion({
        model: "google/gemini-2.5-flash",
        json: true,
        temperature: 0.2,
        timeoutMs: 25_000,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze this garment and return JSON only." },
              { type: "image_url", image_url: { url: data.image_url } },
            ],
          },
        ],
      });
    } catch (err) {
      if (err instanceof AIGatewayError) {
        return {
          ok: false as const,
          error: err.code,
          message:
            err.code === "payment_required"
              ? "AI credits exhausted."
              : err.code === "rate_limited"
                ? "AI provider rate-limited. Try again shortly."
                : "AI analysis failed.",
        };
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false as const, error: "bad_response" as const, message: "AI returned invalid JSON." };
    }

    const result = sanitize(parsed);
    if (!result) {
      return { ok: false as const, error: "bad_response" as const, message: "AI response missing required fields." };
    }
    return { ok: true as const, analysis: result };
  });

function sanitize(raw: unknown): AnalyzeResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const category = typeof r.category === "string" ? r.category.toLowerCase().trim() : "";
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) return null;

  const subRaw = typeof r.subcategory === "string" ? r.subcategory.toLowerCase().trim() : "";
  const subWords = subRaw.split(/\s+/).filter(Boolean);
  const subcategory = subWords.length > 0 && subWords.length <= 3 ? subWords.join(" ") : category;

  const hex = (v: unknown) =>
    typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim() : null;
  const color_primary = hex(r.color_primary) ?? "#888888";
  const color_secondary = hex(r.color_secondary);

  const material = typeof r.material === "string" && r.material.trim().length > 0
    ? r.material.trim().slice(0, 40)
    : "unknown";

  const seasonArr = Array.isArray(r.season) ? r.season : [];
  const season = seasonArr
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.toLowerCase().trim())
    .filter((s): s is (typeof SEASONS)[number] => SEASONS.includes(s as (typeof SEASONS)[number]));

  const fRaw = typeof r.formality_score === "number" ? r.formality_score : Number(r.formality_score);
  const formality_score = Number.isFinite(fRaw) ? Math.min(10, Math.max(1, Math.round(fRaw))) : 5;

  const tagsArr = Array.isArray(r.tags) ? r.tags : [];
  const tags = tagsArr
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.toLowerCase().trim().slice(0, 24))
    .filter((t) => t.length > 0)
    .slice(0, 6);

  return {
    category: category as (typeof CATEGORIES)[number],
    subcategory,
    color_primary,
    color_secondary,
    material,
    season: season.length > 0 ? season : ["spring", "summer", "fall", "winter"],
    formality_score,
    tags,
  };
}

// Real outfit composition via the Lovable AI Gateway (GPT-5).
//
// Flow:
// 1. Auth via requireSupabaseAuth middleware.
// 2. Rate limit: 30/day per user. If exceeded, return early — never hits AI.
// 3. Pull wardrobe + profile, apply hard filters (formality range, season,
//    avoid_colors).
// 4. Reject if missing critical categories (shoes + tops/dress + bottoms/dress).
// 5. Send candidate list to GPT-5 with editorial system prompt.
// 6. Validate ids exist; retry once if hallucinated.
// 7. Apply hard rules client-side; drop looks that fail.
// 8. Insert valid looks into `outfits` with shared batch_id.
// Returns: { batch_id, looks } | { error, ... }
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { checkAndIncrement, RateLimitError } from "@/server/lib/rate-limit";
import { chatCompletion, AIGatewayError } from "@/server/lib/ai-gateway";

const OCCASIONS = [
  "office",
  "casual",
  "evening",
  "athletic",
  "formal",
  "travel",
] as const;
type Occasion = (typeof OCCASIONS)[number];

const MOODS = ["sharp", "easy", "playful"] as const;
type Mood = (typeof MOODS)[number];

interface SuggestInput {
  occasion: Occasion;
  temp_c: number;
  mood?: Mood;
  exclude_batch_id?: string;
}

const FORMALITY_RANGE: Record<Occasion, [number, number]> = {
  office: [7, 10],
  casual: [3, 6],
  evening: [8, 10],
  athletic: [1, 3],
  formal: [9, 10],
  travel: [3, 7],
};

function seasonsForTemp(c: number): string[] {
  if (c < 10) return ["winter", "fall"];
  if (c < 18) return ["fall", "spring"];
  if (c < 25) return ["spring", "summer"];
  return ["summer"];
}

const SYSTEM_PROMPT = `You are a senior stylist with a restrained editorial sensibility — think SSENSE or Mr Porter editorial, not fashion magazine hype. You compose outfits from a user's given wardrobe.

Hard rules:
- Each outfit has exactly 1 top + 1 bottom, OR 1 dress. Shoes are required. Outerwear only if temp_c < 15.
- Formality variance across all items in a single outfit must be ≤ 3 on the 1-10 scale.
- At most one "loud" piece (high-saturation color) per outfit; others must be neutrals or analogous.
- Only use item_ids from the provided wardrobe list. Never invent ids.

Rationale voice:
- Under 40 words. Editorial, observational, restrained.
- Never use "perfect", "stylish", "chic", "elevated", "timeless", "effortless".
- Never exclaim. Never use emoji. Never address the user directly.
- Good: "The wool trousers anchor the look — appropriate for client days, never stiff."
- Good: "Soft against structured. One considered move."
- Bad: "You'll look perfect in this stylish office outfit!"

Name voice:
- 2–4 words. Evocative, not descriptive.
- Good: "The Considered Monday", "Soft Power", "Long Way Home".
- Bad: "Office Outfit 1", "Blue Shirt Look".`;

interface LookProposal {
  item_ids: string[];
  name: string;
  rationale: string;
}

interface CandidateRow {
  id: string;
  category: string | null;
  subcategory: string | null;
  color_primary: string | null;
  color_secondary: string | null;
  material: string | null;
  season: string[] | null;
  formality_score: number | null;
  tags: string[] | null;
  wear_count: number | null;
  last_worn: string | null;
}

export const suggestOutfit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: SuggestInput) => {
    if (!OCCASIONS.includes(input.occasion)) {
      throw new Error("invalid_occasion");
    }
    if (typeof input.temp_c !== "number") {
      throw new Error("invalid_temp_c");
    }
    if (input.mood !== undefined && !MOODS.includes(input.mood)) {
      throw new Error("invalid_mood");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // 1. Rate limit FIRST so we never spend AI budget on rejected requests.
    try {
      await checkAndIncrement(supabase, userId, "suggestOutfit", 30);
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

    // 2. Wardrobe
    const { data: items, error: itemsErr } = await supabase
      .from("wardrobe_items")
      .select(
        "id, category, subcategory, color_primary, color_secondary, material, season, formality_score, tags, wear_count, last_worn",
      )
      .eq("user_id", userId)
      .eq("archived", false);
    if (itemsErr) throw itemsErr;
    if (!items || items.length < 3) {
      return {
        error: "insufficient_wardrobe" as const,
        message: "Add at least 3 items to compose looks.",
      };
    }

    // 3. Profile (for avoid_colors)
    const { data: profile } = await supabase
      .from("profiles")
      .select("avoid_colors, style_archetype")
      .eq("id", userId)
      .maybeSingle();

    // 4. Hard filters
    const [floor, ceiling] = FORMALITY_RANGE[data.occasion];
    const seasons = seasonsForTemp(data.temp_c);
    const avoid = new Set((profile?.avoid_colors ?? []).map((c) => c.toLowerCase()));

    const candidates: CandidateRow[] = (items as CandidateRow[]).filter((it) => {
      // Formality: if no score, allow (vision may not have set it yet)
      if (it.formality_score != null) {
        if (it.formality_score < floor || it.formality_score > ceiling) return false;
      }
      // Season: if tagged, require overlap; if untagged, allow
      if (it.season && it.season.length > 0) {
        if (!it.season.some((s) => seasons.includes(s))) return false;
      }
      // Avoid colors
      if (it.color_primary && avoid.has(it.color_primary.toLowerCase())) {
        return false;
      }
      return true;
    });

    const byCategory = (cat: string) =>
      candidates.filter((c) => c.category === cat);
    const tops = byCategory("top");
    const bottoms = byCategory("bottom");
    const shoes = byCategory("shoes");
    const dresses = byCategory("dress");

    if (
      shoes.length === 0 ||
      (tops.length === 0 && dresses.length === 0) ||
      (bottoms.length === 0 && dresses.length === 0)
    ) {
      const missing: string[] = [];
      if (shoes.length === 0) missing.push("shoes");
      if (tops.length === 0 && dresses.length === 0) missing.push("tops");
      if (bottoms.length === 0 && dresses.length === 0) missing.push("bottoms");
      return {
        error: "insufficient_for_occasion" as const,
        missing,
        occasion: data.occasion,
      };
    }

    // 5. Build compact candidate list for the LLM
    const now = Date.now();
    const candidateList = candidates.map((c) => ({
      id: c.id,
      category: c.category,
      subcategory: c.subcategory,
      formality: c.formality_score,
      color: c.color_primary,
      material: c.material,
      season: c.season,
      worn_days_ago: c.last_worn
        ? Math.floor((now - new Date(c.last_worn).getTime()) / 86_400_000)
        : null,
      tags: c.tags,
    }));

    const userPrompt = `Compose THREE distinct outfits for occasion=${data.occasion} at temp_c=${data.temp_c}°C.
Mood preference: ${data.mood ?? "not specified"}.
Each outfit must differ from the others by at least 2 item_ids.
${data.exclude_batch_id ? "The user already saw a prior set; compose genuinely different looks this time." : ""}

Eligible wardrobe:
${JSON.stringify(candidateList, null, 2)}

Return STRICT JSON, no markdown, no prose:
{
  "looks": [
    { "item_ids": ["<uuid>", ...], "name": "<2-4 words>", "rationale": "<under 40 words>" },
    { "item_ids": [...], "name": "...", "rationale": "..." },
    { "item_ids": [...], "name": "...", "rationale": "..." }
  ]
}`;

    // 6. Call AI gateway with one retry on parse / hallucinated ids
    const candidateIds = new Set(candidates.map((c) => c.id));
    let proposals: LookProposal[] | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      let raw: string;
      try {
        raw = await chatCompletion({
          model: "openai/gpt-5",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          json: true,
          timeoutMs: 60_000,
        });
      } catch (err) {
        if (err instanceof AIGatewayError) {
          if (err.code === "rate_limited" || err.code === "payment_required") {
            return {
              error: "ai_unavailable" as const,
              code: err.code,
              message:
                err.code === "rate_limited"
                  ? "AI is busy. Try again in a moment."
                  : "AI credits exhausted on the workspace.",
            };
          }
        }
        if (attempt === 1) throw err;
        lastError = (err as Error).message;
        continue;
      }

      let parsed: { looks?: LookProposal[] };
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (attempt === 1) {
          return {
            error: "llm_parse_failed" as const,
            message: "Couldn't read the AI response. Try again.",
          };
        }
        lastError = "parse_failed";
        continue;
      }

      const looks = Array.isArray(parsed.looks) ? parsed.looks : [];
      const allValid = looks.every(
        (l) =>
          Array.isArray(l.item_ids) &&
          l.item_ids.every((id) => candidateIds.has(id)),
      );
      if (allValid) {
        proposals = looks;
        break;
      }
      // First attempt failed validation — retry with stricter instruction
      if (attempt === 0) {
        lastError = "hallucinated_ids";
        continue;
      }
      // Second attempt: drop only the bad looks, keep the rest
      proposals = looks.filter((l) =>
        l.item_ids.every((id) => candidateIds.has(id)),
      );
    }

    if (!proposals || proposals.length === 0) {
      return {
        error: "composition_failed" as const,
        message: "Couldn't compose valid looks. Try again.",
        debug: lastError,
      };
    }

    // 7. Hard-rule validation: drop looks that don't pass
    const validLooks = proposals.filter((look) => {
      const lookItems = look.item_ids
        .map((id) => candidates.find((c) => c.id === id))
        .filter((x): x is CandidateRow => Boolean(x));
      if (lookItems.length !== look.item_ids.length) return false;

      const hasShoes = lookItems.some((i) => i.category === "shoes");
      const hasTopBottomOrDress =
        lookItems.some((i) => i.category === "dress") ||
        (lookItems.some((i) => i.category === "top") &&
          lookItems.some((i) => i.category === "bottom"));
      if (!hasShoes || !hasTopBottomOrDress) return false;

      const scores = lookItems
        .map((i) => i.formality_score)
        .filter((s): s is number => typeof s === "number");
      if (scores.length >= 2) {
        const variance = Math.max(...scores) - Math.min(...scores);
        if (variance > 3) return false;
      }
      return true;
    });

    if (validLooks.length === 0) {
      return {
        error: "composition_failed" as const,
        message: "Couldn't compose valid looks. Try again.",
      };
    }

    // 8. Insert into outfits with shared batch_id
    const batch_id = crypto.randomUUID();
    const rows = validLooks.map((look, idx) => ({
      user_id: userId,
      item_ids: look.item_ids,
      name: look.name?.slice(0, 60) ?? null,
      rationale: look.rationale?.slice(0, 400) ?? null,
      occasion: data.occasion,
      context: { temp_c: data.temp_c, mood: data.mood ?? null },
      batch_id,
      look_sequence: idx + 1,
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("outfits")
      .insert(rows)
      .select();
    if (insertErr) throw insertErr;

    return {
      ok: true as const,
      batch_id,
      looks: inserted ?? [],
      requested_count: 3,
      returned_count: validLooks.length,
    };
  });

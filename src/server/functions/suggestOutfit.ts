// Real outfit composition via the Lovable AI Gateway.
//
// Flow:
// 1. Auth via requireSupabaseAuth middleware.
// 2. Rate limit: 30/day per user. If exceeded, return early.
// 3. Pull wardrobe + profile, apply hard filters (formality, season, avoid_colors).
// 4. Reject if missing critical categories.
// 5. Send candidate list to AI with editorial system prompt + reasoning shape.
// 6. Validate + check distinctness; retry once with feedback if needed.
// 7. Log reasoning to styling_logs (diagnostic, never shown to user).
// 8. Insert valid looks into `outfits` with shared batch_id.
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
  office: [5, 10],
  casual: [1, 7],
  evening: [6, 10],
  athletic: [1, 4],
  formal: [8, 10],
  travel: [2, 8],
};

function seasonsForTemp(c: number): string[] {
  if (c < 10) return ["winter", "fall"];
  if (c < 18) return ["fall", "spring"];
  if (c < 25) return ["spring", "summer"];
  return ["summer"];
}

const SYSTEM_PROMPT = `You are a senior stylist with 15 years in editorial and personal styling. Your aesthetic reference is SSENSE, Mr Porter, Totokaelo, The Row, Margaret Howell, Lemaire — restrained, considered, materials-first. You do NOT do trend-chasing, fast fashion, or loud maximalism. You dress clients whose priority is looking quietly correct: right for the occasion, coherent in color and proportion, with one or two deliberate moves that elevate the outfit above generic.

Your styling philosophy has five pillars:

**1. Anchor, then layer.**
Every outfit starts with ONE anchor piece — the item that carries the look's identity. This is usually the bottom (wool trousers, denim, a well-cut chino) or the statement piece (a knit, a jacket, a shirt with character). Everything else is chosen to serve the anchor. Never build from nothing.

**2. Color discipline.**
- Use the 60-30-10 rule: 60% dominant neutral, 30% secondary tone, 10% accent.
- Maximum ONE saturated color per outfit. The rest must be neutrals (black, white, off-white, grey, beige, navy, brown, olive) OR analogous hues within 30° of the saturated piece.
- Avoid mixing warm neutrals (beige, camel, brown, cream) with cool neutrals (cool grey, pure white, icy blue) unless there's a deliberate bridge piece.
- Avoid black head-to-toe unless the occasion calls for it (evening, formal). In casual and office, black should be anchored by at least one lighter neutral.

**3. Silhouette and proportion.**
- Balance fitted with relaxed. Never all-fitted (looks costumey) or all-relaxed (looks sloppy).
- If the top is oversized, the bottom should be cleaner-cut, and vice versa.
- Length proportions: a shorter jacket pairs with full-length trousers; a longer coat balances a crop or tucked top.
- Vertical rhythm: break up the body with a belt, a tucked hem, or a color transition at the waist when appropriate.

**4. Texture and material.**
- Contrast textures within a tight palette (smooth cotton shirt + textured wool trouser reads richer than two smooth pieces).
- Match season: heavy wool doesn't belong in 25°C weather; linen doesn't belong in 5°C.
- Avoid mixing more than one "shiny" material (leather, silk, patent). Two shinies fight each other.
- Denim is casual unless it's indigo rigid raw denim, which can be dressed up slightly.

**5. Formality coherence.**
- All items must sit within a 3-point formality variance on the 1-10 scale.
- A 9-formality blazer cannot be rescued by a 3-formality sneaker. The outfit will look confused.
- For hybrid looks (smart casual), aim for a 5-7 formality band.

Your three-look output follows a STRATEGIC VARIETY RULE: do not produce three visually similar outfits. Each Look must pursue a different strategy:
- **Look 01 — The Expected:** the most occasion-appropriate, most universally correct choice. Safe, but deliberate.
- **Look 02 — The Textured:** built around a material or texture contrast the user might not have tried. Slightly more considered.
- **Look 03 — The Move:** one unexpected choice (an unusual color pairing, a less obvious formality read, an accessory-led composition). Still correct, but with more of the user's personality showing.

Voice rules for rationale:
- Under 40 words. Editorial, observational.
- Never use: "perfect", "stylish", "chic", "elevated", "timeless", "effortless", "classic" (as adjective — "a classic shirt" is fine, "a classic look" is not), "versatile", "sleek", "trendy", "on-trend", "fashion-forward".
- Never exclaim. Never emoji. Never second-person address.
- Good: "The wool trousers anchor the look — appropriate for client days, relaxed enough to walk home in."
- Good: "Two textures, one palette. The knit does the talking."
- Bad: "This perfect office outfit is elevated and effortless!"

Name rules (2–4 words, evocative not descriptive):
- Good: "The Considered Monday", "Soft Power", "Long Way Home", "Quiet Authority", "Late September", "The Understudy".
- Bad: "Office Outfit", "Blue Shirt Combo", "Casual Friday Look".

Hard constraints (must not be violated):
- Exactly 1 top + 1 bottom, OR 1 dress. Shoes are required.
- Outerwear only if temp_c < 15.
- Formality variance ≤ 3.
- Only use item_ids from the provided wardrobe.
- Each of the three Looks must differ from the other two by at least 2 item_ids.`;

interface ReasoningBlock {
  occasion_read?: string;
  palette_strategy?: string;
  anchor_choices?: string;
}

type LookStrategy = "expected" | "textured" | "move";

interface LookProposal {
  strategy?: LookStrategy;
  item_ids: string[];
  name: string;
  rationale: string;
}

interface AIPayload {
  reasoning?: ReasoningBlock;
  looks?: LookProposal[];
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

function buildUserPrompt(args: {
  occasion: Occasion;
  temp_c: number;
  mood?: Mood;
  archetype: string;
  excludeBatchId?: string;
  candidateList: unknown[];
  feedback?: string;
}) {
  const excludeClause = args.excludeBatchId
    ? `\n- The user already saw a prior set; compose genuinely different looks this time.`
    : "";
  const feedbackClause = args.feedback
    ? `\n\nYour previous attempt had problems: ${args.feedback}. Fix them and try again.`
    : "";

  return `Compose THREE looks for:
- Occasion: ${args.occasion}
- Temperature: ${args.temp_c}°C
- Mood preference: ${args.mood ?? "not specified"}
- User's style archetype: ${args.archetype}${excludeClause}

Eligible wardrobe:
${JSON.stringify(args.candidateList, null, 2)}

Think through the composition before outputting. Return strict JSON in this exact shape:

{
  "reasoning": {
    "occasion_read": "one sentence on what this occasion + temp actually demands",
    "palette_strategy": "one sentence on the color direction across all three looks",
    "anchor_choices": "one sentence per look naming which item you chose as its anchor and why"
  },
  "looks": [
    {
      "strategy": "expected" | "textured" | "move",
      "item_ids": ["<uuid>", ...],
      "name": "<2-4 words, evocative>",
      "rationale": "<under 40 words, editorial voice, references a specific item or contrast>"
    },
    { "strategy": "textured", "item_ids": [...], "name": "...", "rationale": "..." },
    { "strategy": "move", "item_ids": [...], "name": "...", "rationale": "..." }
  ]
}

No markdown. No prose outside the JSON. The "reasoning" field is for your internal thinking and will not be shown to the user, but you must produce it — it forces you to plan before picking.${feedbackClause}`;
}

function validateLook(
  look: LookProposal,
  candidates: CandidateRow[],
  temp_c: number,
): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(look.item_ids) || look.item_ids.length === 0) {
    return { ok: false, reason: "no_items" };
  }
  const items = look.item_ids.map((id) => candidates.find((c) => c.id === id));
  if (items.some((i) => !i)) return { ok: false, reason: "hallucinated_id" };
  const resolved = items as CandidateRow[];

  const hasShoes = resolved.some((i) => i.category === "shoes");
  if (!hasShoes) return { ok: false, reason: "no_shoes" };

  const topCount = resolved.filter((i) => i.category === "top").length;
  const bottomCount = resolved.filter((i) => i.category === "bottom").length;
  const dressCount = resolved.filter((i) => i.category === "dress").length;

  if (dressCount > 1) return { ok: false, reason: "multiple_dresses" };
  if (dressCount === 0) {
    if (topCount !== 1 || bottomCount !== 1) {
      return { ok: false, reason: "wrong_top_bottom_count" };
    }
  } else {
    // Dress present: no separate top or bottom allowed
    if (topCount > 0 || bottomCount > 0) {
      return { ok: false, reason: "dress_with_extras" };
    }
  }

  const hasOuterwear = resolved.some((i) => i.category === "outerwear");
  if (hasOuterwear && temp_c >= 15) {
    return { ok: false, reason: "outerwear_too_warm" };
  }

  const scores = resolved
    .map((i) => i.formality_score)
    .filter((s): s is number => typeof s === "number");
  if (scores.length >= 2) {
    const variance = Math.max(...scores) - Math.min(...scores);
    if (variance > 3) return { ok: false, reason: "formality_variance" };
  }

  return { ok: true };
}

function looksAreDistinct(looks: LookProposal[]): boolean {
  for (let i = 0; i < looks.length; i++) {
    for (let j = i + 1; j < looks.length; j++) {
      const a = looks[i].item_ids;
      const b = looks[j].item_ids;
      const overlap = a.filter((id) => b.includes(id)).length;
      const maxLen = Math.max(a.length, b.length);
      if (maxLen - overlap < 2) return false;
    }
  }
  return true;
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

    // 1. Rate limit FIRST.
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

    // 3. Profile
    const { data: profile } = await supabase
      .from("profiles")
      .select("avoid_colors, style_archetype")
      .eq("id", userId)
      .maybeSingle();
    const archetype = profile?.style_archetype ?? "classic";

    // 4. Hard filters
    const [floor, ceiling] = FORMALITY_RANGE[data.occasion];
    const seasons = seasonsForTemp(data.temp_c);
    const avoid = new Set(
      (profile?.avoid_colors ?? []).map((c) => c.toLowerCase()),
    );

    const candidates: CandidateRow[] = (items as CandidateRow[]).filter((it) => {
      if (it.formality_score != null) {
        if (it.formality_score < floor || it.formality_score > ceiling) return false;
      }
      if (it.season && it.season.length > 0) {
        if (!it.season.some((s) => seasons.includes(s))) return false;
      }
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

    // 5. Build candidate list for the LLM
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

    const candidateIds = new Set(candidates.map((c) => c.id));

    // 6. Call AI with one retry that includes feedback
    let payload: AIPayload | null = null;
    let validLooks: LookProposal[] = [];
    let lastReasons: string[] = [];

    for (let attempt = 0; attempt < 2; attempt++) {
      const userPrompt = buildUserPrompt({
        occasion: data.occasion,
        temp_c: data.temp_c,
        mood: data.mood,
        archetype,
        excludeBatchId: data.exclude_batch_id,
        candidateList,
        feedback: attempt === 1 ? lastReasons.join(", ") : undefined,
      });

      let raw: string;
      try {
        raw = await chatCompletion({
          model: "openai/gpt-5",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.75,
          max_tokens: 2000,
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
          if (err.code === "timeout") {
            if (attempt === 1) {
              return {
                error: "ai_unavailable" as const,
                code: "timeout" as const,
                message: "AI took too long. Try again.",
              };
            }
            lastReasons = ["timeout"];
            continue;
          }
        }
        if (attempt === 1) throw err;
        lastReasons = [(err as Error).message];
        continue;
      }

      let parsed: AIPayload;
      try {
        parsed = JSON.parse(raw) as AIPayload;
      } catch {
        if (attempt === 1) {
          return {
            error: "llm_parse_failed" as const,
            message: "Couldn't read the AI response. Try again.",
          };
        }
        lastReasons = ["json_parse_failed"];
        continue;
      }

      payload = parsed;
      const looks = Array.isArray(parsed.looks) ? parsed.looks : [];

      // Filter to only well-formed looks before validation
      const wellFormed = looks.filter(
        (l) =>
          l &&
          Array.isArray(l.item_ids) &&
          l.item_ids.every((id) => typeof id === "string" && candidateIds.has(id)) &&
          typeof l.name === "string" &&
          typeof l.rationale === "string",
      );

      const reasons: string[] = [];
      const passed: LookProposal[] = [];
      for (const look of wellFormed) {
        const r = validateLook(look, candidates, data.temp_c);
        if (r.ok) passed.push(look);
        else reasons.push(`look(${look.strategy ?? "?"}): ${r.reason}`);
      }

      const distinct = passed.length >= 2 ? looksAreDistinct(passed) : true;
      if (!distinct) reasons.push("looks_not_distinct");

      const allLooksValid =
        passed.length === looks.length && distinct && passed.length >= 3;

      if (allLooksValid) {
        validLooks = passed;
        break;
      }

      // Second pass — accept what we have
      if (attempt === 1) {
        // If distinctness failed, drop the offending overlapping look
        if (!distinct && passed.length > 1) {
          const kept: LookProposal[] = [];
          for (const candidate of passed) {
            if (
              kept.every((k) => {
                const overlap = candidate.item_ids.filter((id) =>
                  k.item_ids.includes(id),
                ).length;
                const maxLen = Math.max(
                  candidate.item_ids.length,
                  k.item_ids.length,
                );
                return maxLen - overlap >= 2;
              })
            ) {
              kept.push(candidate);
            }
          }
          validLooks = kept;
        } else {
          validLooks = passed;
        }
        break;
      }

      // First pass failed — set up retry feedback
      lastReasons = reasons.length ? reasons : ["incomplete_output"];
    }

    if (validLooks.length === 0) {
      return {
        error: "composition_failed" as const,
        message: "Couldn't compose valid looks. Try again.",
        debug: lastReasons.join(", "),
      };
    }

    // 7. Insert looks + log reasoning
    const batch_id = crypto.randomUUID();
    const rows = validLooks.map((look, idx) => ({
      user_id: userId,
      item_ids: look.item_ids,
      name: look.name?.slice(0, 60) ?? null,
      rationale: look.rationale?.slice(0, 400) ?? null,
      occasion: data.occasion,
      context: {
        temp_c: data.temp_c,
        mood: data.mood ?? null,
        strategy: look.strategy ?? null,
        archetype,
      },
      batch_id,
      look_sequence: idx + 1,
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("outfits")
      .insert(rows)
      .select();
    if (insertErr) throw insertErr;

    // Diagnostic log — best-effort, never blocks the response
    if (payload?.reasoning) {
      void supabase.from("styling_logs" as any).insert({
        user_id: userId,
        batch_id,
        occasion: data.occasion,
        temp_c: Math.round(data.temp_c),
        mood: data.mood ?? null,
        archetype,
        reasoning: payload.reasoning,
        wardrobe_size: items.length,
        candidate_size: candidates.length,
      });
    }

    return {
      ok: true as const,
      batch_id,
      looks: inserted ?? [],
      requested_count: 3,
      returned_count: validLooks.length,
    };
  });

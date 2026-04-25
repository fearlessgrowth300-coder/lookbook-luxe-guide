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
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { checkAndIncrement, RateLimitError } from "@/server/lib/rate-limit";
import { chatCompletion, AIGatewayError } from "@/server/lib/ai-gateway";
import { hexToColorName } from "@/server/lib/color-names";
import {
  getInspiration,
  inspirationPromptFragment,
  type InspirationStatus,
} from "@/server/lib/inspiration";

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
  /** Optional free-text occasion name (e.g. "job interview at startup"). */
  custom_occasion?: string;
  /** Optional user-provided context describing the occasion in their words. */
  note?: string;
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
- NEVER include hex codes (e.g. "#1C2436"), item UUIDs, raw JSON values, or field names from the candidate list. Reference items by garment type and human color name only ("the olive cargo pants" — never "#727B5C cargo pants" or "the cotton bottom").
- Always use the human color names provided in each candidate's "color_name" field. Common names: navy, cream, olive, charcoal, camel, burgundy, forest, rust, stone, oatmeal, taupe, sand, ecru, ivory, indigo, denim, sage, cognac, brick, mustard, plum.
- Never use: "perfect", "stylish", "chic", "elevated", "timeless", "effortless", "classic" (as adjective — "a classic shirt" is fine, "a classic look" is not), "versatile", "sleek", "trendy", "on-trend", "fashion-forward".
- Never exclaim. Never emoji. Never second-person address.
- Good: "The wool trousers anchor the look — appropriate for client days, relaxed enough to walk home in."
- Good: "Two textures, one palette. The knit does the talking."
- Bad: "This perfect office outfit is elevated and effortless!"
- Bad: "#727B5C cotton blend cargo pants sets the pace; #1C2436 button-down adds quiet structure."

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

interface HeuristicLookArgs {
  candidates: CandidateRow[];
  occasion: Occasion;
  temp_c: number;
}

function buildUserPrompt(args: {
  occasion: Occasion;
  temp_c: number;
  mood?: Mood;
  archetype: string;
  excludeBatchId?: string;
  candidateList: unknown[];
  feedback?: string;
  relaxed?: boolean;
  customOccasion?: string;
  note?: string;
  inspirationFragment?: string;
}) {
  const excludeClause = args.excludeBatchId
    ? `\n- The user already saw a prior set; compose genuinely different looks this time.`
    : "";
  const feedbackClause = args.feedback
    ? `\n\nYour previous attempt had problems: ${args.feedback}. Fix them and try again.`
    : "";
  const relaxedClause = args.relaxed
    ? `\n\nThis wardrobe is small. You may relax:\n- Formality variance can extend to 4 (not 3).\n- If no outerwear is available and temp is 10-15°C, skip outerwear rather than fail.\nTry again and return valid looks even if not ideal.`
    : "";

  const occasionLine = args.customOccasion
    ? `${args.customOccasion} (mapped to closest formality band: ${args.occasion})`
    : args.occasion;
  const noteClause = args.note
    ? `\n- User's notes about the occasion: "${args.note}"\n  Read these carefully and let them shape the looks. They override generic occasion assumptions.`
    : "";

  return `Compose THREE looks for:
- Occasion: ${occasionLine}
- Temperature: ${args.temp_c}°C
- Mood preference: ${args.mood ?? "not specified"}
- User's style archetype: ${args.archetype}${noteClause}${excludeClause}

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

No markdown. No prose outside the JSON. The "reasoning" field is for your internal thinking and will not be shown to the user, but you must produce it — it forces you to plan before picking.${feedbackClause}${relaxedClause}${args.inspirationFragment ?? ""}`;
}

function validateLook(
  look: LookProposal,
  candidates: CandidateRow[],
  temp_c: number,
  opts?: { maxFormalityVariance?: number },
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
    if (variance > (opts?.maxFormalityVariance ?? 3)) {
      return { ok: false, reason: "formality_variance" };
    }
  }

  return { ok: true };
}

function normalizeLookProposal(
  look: LookProposal,
  candidates: CandidateRow[],
): LookProposal {
  const uniqueItemIds = Array.from(new Set(look.item_ids));
  const resolved = uniqueItemIds
    .map((id) => candidates.find((candidate) => candidate.id === id))
    .filter((item): item is CandidateRow => Boolean(item));

  const hasShoes = resolved.some((item) => item.category === "shoes");
  if (hasShoes) {
    return { ...look, item_ids: uniqueItemIds };
  }

  const shoeOptions = candidates.filter((item) => item.category === "shoes");
  if (shoeOptions.length === 1) {
    return {
      ...look,
      item_ids: [...uniqueItemIds, shoeOptions[0].id],
    };
  }

  return { ...look, item_ids: uniqueItemIds };
 }

function buildCandidateSummary(candidates: CandidateRow[]) {
  return {
    total: candidates.length,
    tops: candidates.filter((c) => c.category === "top").length,
    bottoms: candidates.filter((c) => c.category === "bottom").length,
    shoes: candidates.filter((c) => c.category === "shoes").length,
    outerwear: candidates.filter((c) => c.category === "outerwear").length,
    dresses: candidates.filter((c) => c.category === "dress").length,
  };
}

function pairDifferenceCount(a: LookProposal, b: LookProposal) {
  const overlap = a.item_ids.filter((id) => b.item_ids.includes(id)).length;
  return Math.max(a.item_ids.length, b.item_ids.length) - overlap;
}

function pickMostDistinctSubset(looks: LookProposal[], limit = 3): LookProposal[] {
  if (looks.length <= 1) return looks.slice(0, limit);

  const pool = looks.slice(0, limit);
  let bestSubset: LookProposal[] = [pool[0]];
  let bestScore = -1;

  const totalMasks = 1 << pool.length;
  for (let mask = 1; mask < totalMasks; mask++) {
    const subset = pool.filter((_, idx) => (mask & (1 << idx)) !== 0);
    let valid = true;
    let score = 0;

    for (let i = 0; i < subset.length; i++) {
      for (let j = i + 1; j < subset.length; j++) {
        const difference = pairDifferenceCount(subset[i], subset[j]);
        if (difference < 2) {
          valid = false;
          break;
        }
        score += difference;
      }
      if (!valid) break;
    }

    if (
      valid &&
      (subset.length > bestSubset.length ||
        (subset.length === bestSubset.length && score > bestScore))
    ) {
      bestSubset = subset;
      bestScore = score;
    }
  }

  return bestSubset.slice(0, limit);
}

async function persistStylingLog(args: {
  userId: string;
  batchId: string;
  occasion: Occasion;
  tempC: number;
  mood?: Mood;
  archetype: string;
  wardrobeSize: number;
  candidates: CandidateRow[];
  reasoning?: ReasoningBlock;
  rawResponse: unknown;
  validationResults: unknown;
  failureReasons: string[];
  attempt: number;
  mode: "strict" | "relaxed" | "fallback";
}) {
  try {
    await supabaseAdmin.from("styling_logs" as any).insert({
      user_id: args.userId,
      batch_id: args.batchId,
      occasion: args.occasion,
      temp_c: Math.round(args.tempC),
      mood: args.mood ?? null,
      archetype: args.archetype,
      reasoning: args.reasoning ?? null,
      wardrobe_size: args.wardrobeSize,
      candidate_size: args.candidates.length,
      raw_response: args.rawResponse,
      validation_results: {
        attempt: args.attempt,
        mode: args.mode,
        candidate_summary: buildCandidateSummary(args.candidates),
        validation_results: args.validationResults,
      },
      failure_reasons: args.failureReasons,
    });
  } catch (error) {
    console.error("[suggestOutfit] Failed to persist styling log", error);
  }
}

function daysSinceLastWorn(item: CandidateRow) {
  if (!item.last_worn) return 365;
  const days = Math.floor((Date.now() - new Date(item.last_worn).getTime()) / 86_400_000);
  return Number.isFinite(days) ? Math.max(days, 0) : 365;
}

function candidatePriorityScore(item: CandidateRow, targetFormality: number) {
  const formalityPenalty =
    typeof item.formality_score === "number"
      ? Math.abs(item.formality_score - targetFormality)
      : 1.5;
  const wearPenalty = item.wear_count ?? 0;
  const freshnessBonus = Math.min(daysSinceLastWorn(item), 45);
  const materialBonus = item.material ? 1 : 0;
  return freshnessBonus + materialBonus - formalityPenalty * 6 - wearPenalty * 1.25;
}

function buildCandidateShortlist(
  candidates: CandidateRow[],
  occasion: Occasion,
  temp_c: number,
) {
  const [low, high] = FORMALITY_RANGE[occasion];
  const targetFormality = (low + high) / 2;
  const limits: Partial<Record<NonNullable<CandidateRow["category"]>, number>> = {
    top: 5,
    bottom: 5,
    shoes: 4,
    dress: 3,
    outerwear: temp_c < 15 ? 3 : 0,
  };

  return Object.entries(limits).flatMap(([category, limit]) => {
    if (!limit) return [];
    return candidates
      .filter((item) => item.category === category)
      .sort(
        (a, b) =>
          candidatePriorityScore(b, targetFormality) -
          candidatePriorityScore(a, targetFormality),
      )
      .slice(0, limit);
  });
}

function comboScore(items: CandidateRow[], targetFormality: number) {
  const scores = items
    .map((item) => item.formality_score)
    .filter((score): score is number => typeof score === "number");
  const midpoint = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : targetFormality;
  const formalityPenalty = Math.abs(midpoint - targetFormality) * 8;
  const variancePenalty = scores.length > 1 ? (Math.max(...scores) - Math.min(...scores)) * 4 : 0;
  const freshness = items.reduce((sum, item) => sum + Math.min(daysSinceLastWorn(item), 30), 0);
  const wearPenalty = items.reduce((sum, item) => sum + (item.wear_count ?? 0), 0) * 1.1;
  const materials = new Set(items.map((item) => item.material).filter(Boolean));
  const textureBonus = Math.max(0, materials.size - 1) * 3;
  return freshness + textureBonus - formalityPenalty - variancePenalty - wearPenalty;
}

function formatItemLabel(item: CandidateRow | undefined) {
  if (!item) return "the anchor piece";
  const colorName = hexToColorName(item.color_primary);
  return [colorName, item.material, item.subcategory ?? item.category]
    .filter(Boolean)
    .join(" ");
}

function fallbackLookName(occasion: Occasion, index: number) {
  const names: Record<Occasion, string[]> = {
    office: ["Quiet Authority", "Textured Routine", "Late Appointment"],
    casual: ["Long Weekend", "Soft Structure", "Side Street"],
    evening: ["Low Light", "Second Seating", "After Midnight"],
    athletic: ["Early Set", "Track Layer", "Off Duty"],
    formal: ["House Lights", "Black Grain", "Last Arrival"],
    travel: ["Gate Ready", "Soft Transit", "Arrival Hall"],
  };
  return names[occasion][index] ?? `${occasion} look`;
}

function fallbackRationale(strategy: LookStrategy, items: CandidateRow[]) {
  const anchor =
    items.find((item) => item.category === "dress") ??
    items.find((item) => item.category === "bottom") ??
    items.find((item) => item.category === "top") ??
    items[0];
  const support = items.find((item) => item.id !== anchor?.id && item.category !== "shoes") ?? items.find((item) => item.id !== anchor?.id);

  if (strategy === "textured") {
    return `${formatItemLabel(anchor)} sets the pace; ${formatItemLabel(support)} adds a cleaner texture shift.`.slice(0, 160);
  }
  if (strategy === "move") {
    return `${formatItemLabel(anchor)} leads, while ${formatItemLabel(support)} changes the read without losing control.`.slice(0, 160);
  }
  return `${formatItemLabel(anchor)} anchors the look; ${formatItemLabel(support)} keeps the proportions steady.`.slice(0, 160);
}

function buildHeuristicLooks(args: HeuristicLookArgs): LookProposal[] {
  const [low, high] = FORMALITY_RANGE[args.occasion];
  const targetFormality = (low + high) / 2;
  const shortlist = buildCandidateShortlist(args.candidates, args.occasion, args.temp_c);
  const tops = shortlist.filter((item) => item.category === "top");
  const bottoms = shortlist.filter((item) => item.category === "bottom");
  const dresses = shortlist.filter((item) => item.category === "dress");
  const shoes = shortlist.filter((item) => item.category === "shoes");
  const outerwear = shortlist.filter((item) => item.category === "outerwear");
  const outerwearOptions = args.temp_c < 15 ? [undefined, ...outerwear] : [undefined];

  const combos = new Map<string, { items: CandidateRow[]; score: number }>();
  const rememberCombo = (items: CandidateRow[]) => {
    const proposal: LookProposal = {
      item_ids: items.map((item) => item.id),
      name: "",
      rationale: "",
    };
    const validation = validateLook(proposal, shortlist, args.temp_c);
    if (!validation.ok) return;
    const key = proposal.item_ids.slice().sort().join(":");
    const score = comboScore(items, targetFormality);
    const existing = combos.get(key);
    if (!existing || score > existing.score) {
      combos.set(key, { items, score });
    }
  };

  for (const dress of dresses) {
    for (const shoe of shoes) {
      for (const layer of outerwearOptions) {
        rememberCombo([dress, shoe, ...(layer ? [layer] : [])]);
      }
    }
  }

  for (const top of tops) {
    for (const bottom of bottoms) {
      for (const shoe of shoes) {
        for (const layer of outerwearOptions) {
          rememberCombo([top, bottom, shoe, ...(layer ? [layer] : [])]);
        }
      }
    }
  }

  const sorted = Array.from(combos.values()).sort((a, b) => b.score - a.score);
  const chosen: { items: CandidateRow[]; score: number }[] = [];
  for (const combo of sorted) {
    const proposal = { item_ids: combo.items.map((item) => item.id), name: "", rationale: "" };
    if (
      chosen.every((picked) =>
        pairDifferenceCount(
          proposal,
          { item_ids: picked.items.map((item) => item.id), name: "", rationale: "" },
        ) >= 2,
      )
    ) {
      chosen.push(combo);
    }
    if (chosen.length === 3) break;
  }

  const strategies: LookStrategy[] = ["expected", "textured", "move"];
  return chosen.slice(0, 3).map((combo, index) => ({
    strategy: strategies[index] ?? "expected",
    item_ids: combo.items.map((item) => item.id),
    name: fallbackLookName(args.occasion, index),
    rationale: fallbackRationale(strategies[index] ?? "expected", combo.items),
  }));
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
    // Free-text fields: cap length to keep prompt budget bounded.
    if (input.custom_occasion !== undefined) {
      if (typeof input.custom_occasion !== "string") {
        throw new Error("invalid_custom_occasion");
      }
      if (input.custom_occasion.length > 80) {
        input.custom_occasion = input.custom_occasion.slice(0, 80);
      }
    }
    if (input.note !== undefined) {
      if (typeof input.note !== "string") throw new Error("invalid_note");
      if (input.note.length > 400) {
        input.note = input.note.slice(0, 400);
      }
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    try {
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

    const candidatePool =
      candidates.length > 18
        ? buildCandidateShortlist(candidates, data.occasion, data.temp_c)
        : candidates;

    const byCategory = (cat: string) =>
      candidatePool.filter((c) => c.category === cat);
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
    const candidateList = candidatePool.map((c) => ({
      id: c.id,
      category: c.category,
      subcategory: c.subcategory,
      formality: c.formality_score,
      // human color name first; raw hex omitted to discourage echoing
      color_name: hexToColorName(c.color_primary),
      material: c.material,
      season: c.season,
      worn_days_ago: c.last_worn
        ? Math.floor((now - new Date(c.last_worn).getTime()) / 86_400_000)
        : null,
      tags: c.tags,
    }));

    const candidateIds = new Set(candidatePool.map((c) => c.id));

    // 5b. Pinterest inspiration (best-effort, ~24h cached). Never throws —
    //     a failure simply means the stylist runs without external hints.
    const inspirationStatus: InspirationStatus = await getInspiration({
      occasion: data.occasion,
      mood: data.mood ?? null,
      archetype,
    });
    const inspirationFragment = inspirationPromptFragment(inspirationStatus);
    console.log("[suggestOutfit] inspiration:", inspirationStatus.state, {
      pin_count:
        inspirationStatus.state === "cached" || inspirationStatus.state === "fresh"
          ? inspirationStatus.data.pin_count
          : 0,
    });

    // 6. Call AI once with a tight timeout; if it stalls or returns bad output,
    //    fall back to a deterministic local composition so the user still gets looks.
    let payload: AIPayload | null = null;
    let validLooks: LookProposal[] = [];
    let lastReasons: string[] = [];
    const batch_id = crypto.randomUUID();
    const MAX_AI_ATTEMPTS = 1;

    for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
      const relaxed = attempt === 1 && lastReasons.length > 0;
      const userPrompt = buildUserPrompt({
        occasion: data.occasion,
        temp_c: data.temp_c,
        mood: data.mood,
        archetype,
        excludeBatchId: data.exclude_batch_id,
        candidateList,
        feedback: attempt === 1 ? lastReasons.join(", ") : undefined,
        relaxed,
        customOccasion: data.custom_occasion,
        note: data.note,
        inspirationFragment,
      });

      let raw: string;
      try {
        raw = await chatCompletion({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 2000,
          json: true,
          timeoutMs: 25_000,
        });
      } catch (err) {
        if (err instanceof AIGatewayError) {
          lastReasons = [`ai_${err.code}`];
          console.warn("[suggestOutfit] AI fallback trigger:", err.code, err.message);
          break;
        }
        lastReasons = [(err as Error).message];
        break;
      }

      let parsed: AIPayload;
      try {
        parsed = JSON.parse(raw) as AIPayload;
      } catch {
        lastReasons = ["json_parse_failed"];
        break;
      }

      payload = parsed;
      const looks = Array.isArray(parsed.looks)
        ? parsed.looks.slice(0, 3).map((look) => normalizeLookProposal(look, candidatePool))
        : [];

      console.log("[suggestOutfit] LLM response:", JSON.stringify(parsed, null, 2));

      const validationResults = looks.map((look) => {
        const wellFormed =
          !!look &&
          Array.isArray(look.item_ids) &&
          look.item_ids.every((id) => typeof id === "string" && candidateIds.has(id)) &&
          typeof look.name === "string" &&
          typeof look.rationale === "string";

        const result = wellFormed
          ? validateLook(look, candidatePool, data.temp_c, {
              maxFormalityVariance: relaxed ? 4 : 3,
            })
          : ({ ok: false, reason: "hallucinated_id" } as const);

        return {
          look_name: typeof look?.name === "string" ? look.name : null,
          item_ids: Array.isArray(look?.item_ids) ? look.item_ids : [],
          result,
        };
      });
      console.log("[suggestOutfit] Validation results:", validationResults);

      const distinctResult = looks.length >= 2 ? looksAreDistinct(looks) : true;
      console.log("[suggestOutfit] Distinct check:", distinctResult);

      const candidateSummary = buildCandidateSummary(candidatePool);
      console.log("[suggestOutfit] Candidates available:", candidateSummary);

      const reasons = validationResults.flatMap((entry) =>
        entry.result.ok ? [] : [entry.result.reason],
      );

      if (looks.length === 0) {
        reasons.push("no_looks_returned");
      } else if (looks.length < 3) {
        reasons.push(`returned_${looks.length}_looks`);
      }

      if (!distinctResult && validationResults.some((entry) => entry.result.ok)) {
        reasons.push("looks_not_distinct");
      }

      await persistStylingLog({
        userId,
        batchId: batch_id,
        occasion: data.occasion,
        tempC: data.temp_c,
        mood: data.mood,
        archetype,
        wardrobeSize: items.length,
        candidates: candidatePool,
        reasoning: parsed.reasoning,
        rawResponse: parsed,
        validationResults,
        failureReasons: reasons,
        attempt: attempt + 1,
        mode: relaxed ? "relaxed" : "strict",
      });

      const strictlyValidLooks = looks.filter((_, idx) => validationResults[idx]?.result.ok);
      const distinctValidLooks =
        strictlyValidLooks.length >= 2
          ? pickMostDistinctSubset(strictlyValidLooks, 3)
          : strictlyValidLooks;

      if (distinctValidLooks.length >= 3) {
        validLooks = distinctValidLooks.slice(0, 3);
        break;
      }

      if (distinctValidLooks.length >= 2) {
        validLooks = distinctValidLooks;
        break;
      }

      if (strictlyValidLooks.length === 1) {
        validLooks = strictlyValidLooks;
        break;
      }

      console.error("[suggestOutfit] All looks invalid. Reasons:", reasons);

      if (attempt === 1) {
        lastReasons = reasons.length ? reasons : ["incomplete_output"];
        break;
      }

      lastReasons = reasons.length ? reasons : ["incomplete_output"];
    }

    if (validLooks.length === 0) {
      const fallbackLooks = buildHeuristicLooks({
        candidates: candidatePool,
        occasion: data.occasion,
        temp_c: data.temp_c,
      });

      if (fallbackLooks.length > 0) {
        const fallbackValidation = fallbackLooks.map((look) => ({
          look_name: look.name,
          item_ids: look.item_ids,
          result: validateLook(look, candidatePool, data.temp_c, {
            maxFormalityVariance: 4,
          }),
        }));

        await persistStylingLog({
          userId,
          batchId: batch_id,
          occasion: data.occasion,
          tempC: data.temp_c,
          mood: data.mood,
          archetype,
          wardrobeSize: items.length,
          candidates: candidatePool,
          reasoning: payload?.reasoning,
          rawResponse: payload ?? { fallback: true },
          validationResults: fallbackValidation,
          failureReasons: lastReasons.length > 0 ? lastReasons : ["fallback_composer"],
          attempt: 1,
          mode: "fallback",
        });

        validLooks = fallbackLooks;
      }
    }

    if (validLooks.length === 0) {
      return {
        error: "composition_failed" as const,
        reasons: lastReasons,
        message: `AI composition issue: ${lastReasons[0] ?? "unknown"}. Your wardrobe may need more variety.`,
      };
    }

    // 7. Insert looks + log reasoning
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
        custom_occasion: data.custom_occasion ?? null,
        user_note: data.note ?? null,
        low_variety: validLooks.length < 3,
        inspiration: {
          state: inspirationStatus.state,
          ...(inspirationStatus.state === "cached" || inspirationStatus.state === "fresh"
            ? {
                pin_count: inspirationStatus.data.pin_count,
                palette: inspirationStatus.data.palette,
                aesthetic_tags: inspirationStatus.data.aesthetic_tags,
              }
            : { reason: inspirationStatus.reason }),
        },
      },
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
      note: validLooks.length < 3 ? "low_variety" : null,
      inspiration: inspirationStatus,
    };
    } catch (err) {
      // Last-resort safety net: never let an uncaught error reach the client
      // as a 500. The client surfaces the toast `Couldn't compose looks` only
      // for `error: "unexpected"` — we always include the message so the user
      // gets a meaningful hint instead of the generic toast.
      const message =
        err instanceof AIGatewayError
          ? `AI gateway: ${err.message}`
          : err instanceof Error
            ? err.message
            : "unknown_error";
      console.error("[suggestOutfit] Unhandled error:", err);
      return {
        error: "unexpected" as const,
        message,
      };
    }
  });

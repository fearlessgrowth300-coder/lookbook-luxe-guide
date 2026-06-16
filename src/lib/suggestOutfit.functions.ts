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
import { hexToColorName } from "@/lib/color-names";
import { type InspirationStatus } from "@/server/lib/inspiration";

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
  /** Optional client-provided list of recent batch ids to also avoid. */
  exclude_batch_ids?: string[];
  /** Recent batch ids from the current session — items appearing across them get heavily penalised. */
  exclude_recent_batch_ids?: string[];
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

const SYSTEM_PROMPT = `You are Marcus Chen, senior personal stylist with 18 years in editorial and private client styling. Your clients are executives, creatives, and culturally-minded men across Lagos, London, and New York. You dress people who care about looking correct — not flashy, not generic, but intentional.

You were trained at Condé Nast, styled for GQ Africa and Monocle, and now run a private client practice. You think in silhouettes, color temperatures, and what a garment DOES for the person wearing it — not what category it belongs to.

---

YOUR FIVE STYLIST INSTINCTS (apply every single time):

**INSTINCT 1: ANCHOR FIRST, THEN BUILD**
Every look starts with ONE anchor piece — the item that defines the look's identity. Usually the trouser or key top. Everything else serves the anchor. Never start with accessories and work backwards.

**INSTINCT 2: 60-30-10 COLOR TEMPERATURE**
60% dominant neutral (navy, cream, camel, olive, grey, white, black).
30% secondary tone — related to the dominant, not competing.
10% accent — one deliberate contrast or statement.
NEVER mix warm neutrals (beige, camel, cream, brown) with cool neutrals (pure white, cool grey, icy blue) unless there is a BRIDGE PIECE in a temperature-neutral color (like stone, taupe, or a textured knit that reads both warm and cool).

**INSTINCT 3: ONE THING AT A TIME**
A look can have: one interesting silhouette, OR one interesting texture, OR one interesting color story. Not all three at once. The eye needs somewhere to rest.

**INSTINCT 4: PROPORTION IS ARCHITECTURE**
- Oversized top → cleaner bottom (slim or straight cut)
- Relaxed trouser → structured top (fitted, tucked, or with defined shoulder)
- Long outerwear → don't lose the bottom (trouser must extend cleanly below coat hem)
- Short outerwear → trouser can be any length
- Wide trousers → footwear with visual weight (loafer, chunky sole) not whisper-thin shoes

**INSTINCT 5: SHOES ARE THE FINAL DECISION, NOT AN AFTERTHOUGHT**
Shoes set the register of the entire look. A trouser + shirt outfit can read business casual with a clean derby or read creative-casual with a suede loafer. The shoe completes the story.

A statement dress shoe (studded loafer, mule, evening-leaning) reads evening-to-smart-formal. Pair with tailored trousers (not denim, not cargo), a clean fitted top (no graphic), minimal accessories so the shoe carries the interest. It ELEVATES rather than overdresses when the rest is restrained.

---

CLIMATE-AWARE STYLING (Lagos context):
You understand that Lagos operates in two broad seasons: harmattan (Oct–Feb, dry, dusty, cooler mornings) and wet season (Mar–Sep, humid, hot, sudden rain). Temperature alone doesn't tell the story.

- Above 28°C: breathable fabrics only. No wool, no heavy denim, no multiple layers. Linen, cotton, poplin, light knits.
- Harmattan: light layering acceptable. Dust = keep shoes less precious (no suede).
- Rain season: waterproof or easy-clean shoes. Avoid trailing trouser hems.
- Office (likely air-conditioned): you can suggest a layer the user keeps on indoors.

---

THE THREE-LOOK STRATEGY (ALWAYS follow this):

**LOOK 01 — "THE OBVIOUS" (done perfectly)**
The most contextually correct interpretation of the occasion. Safe but deliberate. The look that says "I got dressed with intention." Nothing surprising. If a client said "I have a client meeting at 10am" — this is what you'd recommend without hesitation.

**LOOK 02 — "THE TEXTURE MOVE"**
The same occasion, interpreted through a material or texture contrast the client might not have tried. One unexpected sensory element — a nap, a weave, a surface contrast — but stays within the color discipline of Look 01. This is how you show range without breaking rules.

**LOOK 03 — "THE POINT OF VIEW"**
The bravest of the three, but never wrong for the occasion. One deliberate choice that reveals personality. A color pairing that's unconventional but correct (olive + burgundy for an evening look). A proportion break. A shoe that elevates instead of matching. For the person who wants to be noticed for the RIGHT reason, not just dressed.

---

RATIONALE WRITING GUIDE:

Voice: magazine editor who writes in short, observed sentences. Not hype. Not instructions. Observation.

GOOD examples:
- "The olive cargo trouser is doing two things at once — casual enough for Friday, structured enough for the meeting after lunch."
- "Navy on navy works here because the textures disagree. One smooth, one ribbed. That's the whole look."
- "The mule reads evening, but the relaxed trouser brings it back to Saturday afternoon."
- "Camel and cream sound like the same note played twice. They're not — one is warm, one is warm-adjacent."

BANNED words/phrases: perfect, stylish, chic, elevated, timeless, effortless, versatile, sleek, trendy, on-trend, fashion-forward, great for, you'll love, ideal for, polished.

Never exclaim. Never use second person ("you"). Never include hex codes. Never repeat the word "look" more than once. Under 45 words per rationale.

Use the human color name from each candidate's "color_name" field. Never output raw hex.

---

HARD CONSTRAINTS (non-negotiable):
- Exactly 1 top + 1 bottom, OR 1 dress. Shoes required. Outerwear only if temp_c < 18 or occasion demands.
- Formality variance across items ≤ 3 (on the 1-10 scale).
- At most 1 saturated color piece per look. Others = neutrals or analogous.
- Only use item_ids from the provided wardrobe list. No hallucinated IDs.
- Each of the 3 Looks must differ from the other 2 by at least 3 item_ids (not just 2).
- The same shoe must NOT appear in all 3 Looks (unless there is only 1 shoe available — then note this in the rationale of Look 02 and 03 with a 1-sentence "Add another shoe to diversify these looks").

---

OUTPUT FORMAT (strict JSON, no markdown, no prose outside):
{
  "reasoning": {
    "occasion_read": "one sentence",
    "palette_strategy": "one sentence covering all 3 looks",
    "shoe_strategy": "which shoes you assigned to which look and why",
    "anchor_choices": "one anchor per look and why"
  },
  "looks": [
    {
      "strategy": "obvious",
      "item_ids": ["uuid", ...],
      "name": "2-4 word evocative name",
      "rationale": "under 45 words, editorial voice",
      "details": {
        "color_story": "one sentence on color logic",
        "proportion": "one sentence on silhouette balance",
        "shoe_note": "one sentence on why this shoe for this look"
      }
    },
    { "strategy": "texture_move", "item_ids": [...], "name": "...", "rationale": "...", "details": {...} },
    { "strategy": "point_of_view", "item_ids": [...], "name": "...", "rationale": "...", "details": {...} }
  ]
}`;

interface ReasoningBlock {
  occasion_read?: string;
  palette_strategy?: string;
  anchor_choices?: string;
}

type LookStrategy =
  | "expected"
  | "textured"
  | "move"
  | "obvious"
  | "texture_move"
  | "point_of_view";

interface LookDetails {
  color_story?: string;
  proportion?: string;
  shoe_note?: string;
}

interface LookProposal {
  strategy?: LookStrategy;
  item_ids: string[];
  name: string;
  rationale: string;
  details?: LookDetails;
}

interface AIPayload {
  reasoning?: ReasoningBlock & { shoe_strategy?: string };
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
  priorSignatures?: string[][];
}

function buildUserPrompt(args: {
  occasion: Occasion;
  temp_c: number;
  mood?: Mood;
  archetype: string;
  excludeBatchId?: string;
  shoesList: unknown[];
  otherCandidates: unknown[];
  feedback?: string;
  relaxed?: boolean;
  customOccasion?: string;
  note?: string;
  priorSignatures?: string[][];
  inspirationDna?: string[];
  singleShoeWarning?: boolean;
}) {
  const excludeClause = args.excludeBatchId
    ? `\n- The user already saw a prior set; compose genuinely different looks this time.`
    : "";
  const feedbackClause = args.feedback
    ? `\n\nYour previous attempt had problems: ${args.feedback}. Fix them and try again.`
    : "";
  const relaxedClause = args.relaxed
    ? `\n\nThis wardrobe is small. You may relax:\n- Formality variance can extend to 4 (not 3).\n- Distinct-by-3 may relax to distinct-by-2 if combinations are exhausted.\nTry again and return valid looks even if not ideal.`
    : "";

  const occasionLine = args.customOccasion
    ? `${args.customOccasion} (mapped to closest formality band: ${args.occasion})`
    : args.occasion;
  const noteClause = args.note
    ? `\n- User's notes about the occasion: "${args.note}"\n  Read these carefully and let them shape the looks. They override generic occasion assumptions.`
    : "";

  const priorClause =
    args.priorSignatures && args.priorSignatures.length > 0
      ? `\n\nRECENTLY SHOWN (avoid repeating these combinations). Each Look you produce must differ from every prior signature by at least 3 item_ids:\n${args.priorSignatures
          .slice(0, 10)
          .map((sig, i) => `- Prior ${i + 1}: [${sig.join(", ")}]`)
          .join("\n")}`
      : "";

  const dnaClause =
    args.inspirationDna && args.inspirationDna.length > 0
      ? `\n- Inspiration DNA: ${args.inspirationDna.join(", ")}\n  Lean into these aesthetic signals when choosing combinations and writing rationales.`
      : `\n- Inspiration DNA: not set`;

  const singleShoeClause = args.singleShoeWarning
    ? `\n\nNOTE: only ONE shoe is available for this occasion. Include it in all looks but mention in Look 02 and Look 03 rationales that adding another shoe would diversify the looks.`
    : "";

  const day = new Date().toLocaleDateString("en-US", { weekday: "long" });

  return `Compose THREE looks (obvious / texture_move / point_of_view) for:
- Occasion: ${occasionLine}
- Temperature: ${args.temp_c}°C
- Day: ${day}
- Mood: ${args.mood ?? "unspecified"}
- Style archetype: ${args.archetype}${dnaClause}${noteClause}${excludeClause}${priorClause}${singleShoeClause}

SHOES IN THIS WARDROBE — assign each shoe to at most 2 of the 3 looks (unless only 1 shoe is available):
${JSON.stringify(args.shoesList, null, 2)}

ELIGIBLE WARDROBE (non-shoe items):
${JSON.stringify(args.otherCandidates, null, 2)}

Decide your shoe assignments FIRST, then build each look around its assigned shoe and chosen anchor. Return strict JSON per the Output Format specified in your system instructions. No markdown.${feedbackClause}${relaxedClause}`;
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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

function comboScore(
  items: CandidateRow[],
  targetFormality: number,
  priorItemPenalty?: Map<string, number>,
) {
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
  // Penalise items that appeared in recent looks for this occasion.
  const priorPenalty = priorItemPenalty
    ? items.reduce((sum, item) => sum + (priorItemPenalty.get(item.id) ?? 0), 0)
    : 0;
  // Random jitter so identical inputs don't produce identical outputs.
  const jitter = Math.random() * 6;
  return freshness + textureBonus + jitter - formalityPenalty - variancePenalty - wearPenalty - priorPenalty;
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

  // Per-item penalty: items appearing in more recent prior signatures get
  // larger penalties (weighted by recency — most recent prior counts most).
  const priorItemPenalty = new Map<string, number>();
  const priorSigs = args.priorSignatures ?? [];
  priorSigs.forEach((sig, idx) => {
    // weight: most recent prior = ~12, decays to ~3 for the 10th prior
    const weight = Math.max(3, 12 - idx);
    for (const id of sig) {
      priorItemPenalty.set(id, (priorItemPenalty.get(id) ?? 0) + weight);
    }
  });

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
    const score = comboScore(items, targetFormality, priorItemPenalty);
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

  // Reject combos that overlap any prior signature by 2+ items, but only if
  // there are enough non-overlapping combos available — otherwise fall back
  // to the full pool so we still return something.
  const overlapsPrior = (ids: string[]) =>
    priorSigs.some((sig) => {
      const set = new Set(sig);
      const overlap = ids.filter((id) => set.has(id)).length;
      return overlap >= 2;
    });

  const allCombos = Array.from(combos.values()).sort((a, b) => b.score - a.score);
  const fresh = allCombos.filter((c) => !overlapsPrior(c.items.map((i) => i.id)));
  const sorted = fresh.length >= 3 ? fresh : fresh.length > 0 ? fresh : allCombos;

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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
      .eq("archived", false)
      .eq("is_dirty", false);
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

    // 3b. Recent looks for this occasion (last 7 days, up to 10).
    //     Used to avoid repeating the same composition each time the user
    //     taps Generate.
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const { data: recentOutfits } = await supabase
      .from("outfits")
      .select("item_ids, batch_id, generated_at")
      .eq("user_id", userId)
      .eq("occasion", data.occasion)
      .gte("generated_at", sevenDaysAgo)
      .order("generated_at", { ascending: false })
      .limit(10);
    const priorSignatures: string[][] = (recentOutfits ?? [])
      .map((row) => (Array.isArray(row.item_ids) ? (row.item_ids as string[]) : []))
      .filter((sig) => sig.length > 0);
    console.log(
      "[suggestOutfit] prior signatures:",
      priorSignatures.length,
      "for occasion",
      data.occasion,
    );

    // 4. Hard filters
    const [floor, ceiling] = FORMALITY_RANGE[data.occasion];
    const seasons = seasonsForTemp(data.temp_c);
    const avoid = new Set(
      (profile?.avoid_colors ?? []).map((c) => c.toLowerCase()),
    );

    const passesFormality = (score: number | null, lo: number, hi: number) =>
      score == null || (score >= lo && score <= hi);

    const candidates: CandidateRow[] = (items as CandidateRow[]).filter((it) => {
      if (!passesFormality(it.formality_score, floor, ceiling)) return false;
      if (it.season && it.season.length > 0) {
        if (!it.season.some((s) => seasons.includes(s))) return false;
      }
      if (it.color_primary && avoid.has(it.color_primary.toLowerCase())) {
        return false;
      }
      return true;
    });

    // Adaptive shoe pool: if fewer than 2 shoes pass the strict formality
    // filter, expand the range by ±2 so the user isn't stuck with one shoe.
    let adaptiveShoes: CandidateRow[] = candidates.filter((c) => c.category === "shoes");
    if (adaptiveShoes.length < 2) {
      const wideLo = Math.max(1, floor - 2);
      const wideHi = Math.min(10, ceiling + 2);
      const wideShoes = (items as CandidateRow[]).filter((it) => {
        if (it.category !== "shoes") return false;
        if (!passesFormality(it.formality_score, wideLo, wideHi)) return false;
        if (it.season && it.season.length > 0) {
          if (!it.season.some((s) => seasons.includes(s))) return false;
        }
        if (it.color_primary && avoid.has(it.color_primary.toLowerCase())) {
          return false;
        }
        return true;
      });
      // Merge in any shoes not already in candidates.
      const existingShoeIds = new Set(adaptiveShoes.map((s) => s.id));
      for (const s of wideShoes) {
        if (!existingShoeIds.has(s.id)) {
          candidates.push(s);
          existingShoeIds.add(s.id);
        }
      }
      adaptiveShoes = candidates.filter((c) => c.category === "shoes");
    }
    const singleShoeWarning = adaptiveShoes.length === 1;

    // Session-level exclusion: items that appear in ALL of the last few
    // batches from this session get removed from the candidate pool.
    if (data.exclude_recent_batch_ids && data.exclude_recent_batch_ids.length > 0) {
      const { data: recentBatchRows } = await supabase
        .from("outfits")
        .select("item_ids, batch_id")
        .in("batch_id", data.exclude_recent_batch_ids)
        .eq("user_id", userId);
      const batchCount = data.exclude_recent_batch_ids.length;
      const perBatch = new Map<string, Set<string>>();
      (recentBatchRows ?? []).forEach((row) => {
        if (!row.batch_id) return;
        const ids = Array.isArray(row.item_ids) ? (row.item_ids as string[]) : [];
        const existing = perBatch.get(row.batch_id) ?? new Set<string>();
        ids.forEach((id) => existing.add(id));
        perBatch.set(row.batch_id, existing);
      });
      const itemFreq: Record<string, number> = {};
      perBatch.forEach((set) =>
        set.forEach((id) => {
          itemFreq[id] = (itemFreq[id] || 0) + 1;
        }),
      );
      const fullyRepeated = new Set(
        Object.entries(itemFreq)
          .filter(([, freq]) => freq >= batchCount && batchCount >= 2)
          .map(([id]) => id),
      );
      if (fullyRepeated.size > 0) {
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (fullyRepeated.has(candidates[i].id)) {
            const cat = candidates[i].category;
            const remainingInCat = candidates.filter(
              (c) => c.category === cat && !fullyRepeated.has(c.id),
            ).length;
            if (remainingInCat > 0) candidates.splice(i, 1);
          }
        }
      }
    }

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

    // 5. Build candidate list for the LLM — shoes separated from the rest
    //    so the model decides shoe register first, then builds around it.
    const now = Date.now();
    const mapCandidate = (c: CandidateRow) => ({
      id: c.id,
      category: c.category,
      subcategory: c.subcategory,
      formality: c.formality_score,
      color_name: hexToColorName(c.color_primary),
      material: c.material,
      season: c.season,
      wear_count: c.wear_count ?? 0,
      worn_days_ago: c.last_worn
        ? Math.floor((now - new Date(c.last_worn).getTime()) / 86_400_000)
        : null,
      tags: c.tags,
    });
    const shoesList = candidatePool
      .filter((c) => c.category === "shoes")
      .map((c) => ({
        id: c.id,
        subcategory: c.subcategory,
        formality: c.formality_score,
        color_name: hexToColorName(c.color_primary),
        material: c.material,
      }));
    const otherCandidates = candidatePool
      .filter((c) => c.category !== "shoes")
      .map(mapCandidate);

    const candidateIds = new Set(candidatePool.map((c) => c.id));

    // 5b. Inspiration disabled (Pinterest API broken). Style DNA picker
    //     is the planned replacement — see plan.md.
    // 5b. Inspiration disabled (Pinterest API broken). Style DNA picker
    //     is the planned replacement — see plan.md.
    const inspirationStatus: InspirationStatus = {
      state: "skipped",
      reason: "no_apify_key",
    };
    const inspirationDna: string[] = [];

    // 6. Call AI; fall back to deterministic composition on failure.
    let payload: AIPayload | null = null;
    let validLooks: LookProposal[] = [];
    let lastReasons: string[] = [];
    const batch_id = crypto.randomUUID();
    const MAX_AI_ATTEMPTS = 2;

    // Helper: count overlap between a look and the worst-matching prior signature.
    const maxPriorOverlap = (ids: string[]) => {
      let max = 0;
      for (const sig of priorSignatures) {
        const set = new Set(sig);
        const overlap = ids.filter((id) => set.has(id)).length;
        if (overlap > max) max = overlap;
      }
      return max;
    };

    for (let attempt = 0; attempt < MAX_AI_ATTEMPTS; attempt++) {
      const relaxed = attempt === 1 && lastReasons.length > 0;
      const userPrompt = buildUserPrompt({
        occasion: data.occasion,
        temp_c: data.temp_c,
        mood: data.mood,
        archetype,
        excludeBatchId: data.exclude_batch_id,
        shoesList,
        otherCandidates,
        feedback: attempt >= 1 ? lastReasons.join(", ") : undefined,
        relaxed,
        customOccasion: data.custom_occasion,
        note: data.note,
        priorSignatures,
        inspirationDna,
        singleShoeWarning,
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

      // Filter out looks that overlap a prior signature by 2+ items, unless
      // doing so would leave us with nothing. Tiny wardrobes get a pass.
      const freshLooks = strictlyValidLooks.filter(
        (look) => maxPriorOverlap(look.item_ids) < 2,
      );
      const usableLooks =
        freshLooks.length >= 2 || (freshLooks.length >= 1 && strictlyValidLooks.length === freshLooks.length)
          ? freshLooks
          : freshLooks.length > 0 && attempt + 1 >= MAX_AI_ATTEMPTS
            ? freshLooks
            : strictlyValidLooks;

      const distinctValidLooks =
        usableLooks.length >= 2
          ? pickMostDistinctSubset(usableLooks, 3)
          : usableLooks;

      if (distinctValidLooks.length >= 3) {
        // Shoe distribution check: if there are ≥2 shoes available but the
        // AI used the same shoe in all 3 looks, retry once with feedback.
        const shoeIdSet = new Set(shoesList.map((s) => s.id));
        const shoesUsed = distinctValidLooks.slice(0, 3).map((look) =>
          look.item_ids.find((id) => shoeIdSet.has(id)),
        );
        const uniqueShoes = new Set(shoesUsed.filter(Boolean) as string[]);
        if (
          shoesList.length >= 2 &&
          uniqueShoes.size === 1 &&
          attempt + 1 < MAX_AI_ATTEMPTS
        ) {
          console.log("[suggestOutfit] Single shoe across 3 looks — retrying for distribution.");
          lastReasons = [
            "You used the same shoe in all 3 looks but multiple shoes are available. Distribute different shoes across at least 2 of the 3 looks.",
          ];
          continue;
        }
        validLooks = distinctValidLooks.slice(0, 3);
        break;
      }


      if (distinctValidLooks.length >= 2) {
        validLooks = distinctValidLooks;
        break;
      }

      if (usableLooks.length === 1 && attempt + 1 >= MAX_AI_ATTEMPTS) {
        validLooks = usableLooks;
        break;
      }

      console.error("[suggestOutfit] All looks invalid or repeated. Reasons:", reasons);

      // Set feedback so the next attempt knows what went wrong.
      const feedbackReasons = [...reasons];
      if (strictlyValidLooks.length > 0 && freshLooks.length === 0) {
        feedbackReasons.push("looks_repeated_priors");
      }
      lastReasons = feedbackReasons.length ? feedbackReasons : ["incomplete_output"];
    }

    if (validLooks.length === 0) {
      const fallbackLooks = buildHeuristicLooks({
        candidates: candidatePool,
        occasion: data.occasion,
        temp_c: data.temp_c,
        priorSignatures,
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
        inspiration: { state: inspirationStatus.state, reason: inspirationStatus.reason },
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

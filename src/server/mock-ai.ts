/**
 * Mock AI responses for Pass 1.
 *
 * Each function returns a Promise matching the EXACT shape the real
 * OpenAI / remove.bg responses will have. In Pass 2 these become
 * `createServerFn` wrappers around real API calls — no UI changes required.
 *
 * All functions include a 600–1200ms artificial delay so loading states
 * feel real during development.
 */

const delay = (min = 600, max = 1200) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min)),
  );

// ─────────────────────────────────────────────────────────────────────────────
// remove.bg — POST /v1.0/removebg
// Real response: binary PNG. We model the shape our edge fn will return.
// ─────────────────────────────────────────────────────────────────────────────
export interface RemoveBgResult {
  /** Public/signed URL to the bg-removed PNG in wardrobe-enhanced */
  enhanced_path: string;
  /** Bytes (used for cost tracking) */
  size_bytes: number;
}

export async function mockRemoveBackground(input: {
  user_id: string;
  item_id: string;
  raw_path: string;
}): Promise<RemoveBgResult> {
  await delay();
  // In real impl this writes to wardrobe-enhanced bucket.
  return {
    enhanced_path: `${input.user_id}/${input.item_id}.png`,
    size_bytes: 184_320,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Vision — gpt-4o-mini garment analysis
// Strict JSON shape per spec §4.
// ─────────────────────────────────────────────────────────────────────────────
export type Category =
  | "top"
  | "bottom"
  | "outerwear"
  | "dress"
  | "shoes"
  | "accessory"
  | "bag";

export type Season = "spring" | "summer" | "fall" | "winter";

export interface GarmentAnalysis {
  category: Category;
  subcategory: string;
  color_primary: string; // hex
  color_secondary: string | null;
  material: string;
  season: Season[];
  formality_score: number; // 1–10
  tags: string[]; // max 6
}

const ARCHETYPES: GarmentAnalysis[] = [
  {
    category: "top",
    subcategory: "oxford shirt",
    color_primary: "#F5F1EA",
    color_secondary: null,
    material: "cotton poplin",
    season: ["spring", "summer", "fall"],
    formality_score: 7,
    tags: ["crisp", "tailored", "versatile", "neutral"],
  },
  {
    category: "bottom",
    subcategory: "wool trousers",
    color_primary: "#2F2A26",
    color_secondary: null,
    material: "wool flannel",
    season: ["fall", "winter"],
    formality_score: 8,
    tags: ["pleated", "tailored", "classic"],
  },
  {
    category: "outerwear",
    subcategory: "wool coat",
    color_primary: "#5B4B3A",
    color_secondary: null,
    material: "double-faced wool",
    season: ["fall", "winter"],
    formality_score: 8,
    tags: ["overcoat", "structured", "investment"],
  },
  {
    category: "shoes",
    subcategory: "leather loafer",
    color_primary: "#3B2418",
    color_secondary: null,
    material: "calf leather",
    season: ["spring", "summer", "fall"],
    formality_score: 7,
    tags: ["penny", "polished", "italian"],
  },
  {
    category: "accessory",
    subcategory: "silk scarf",
    color_primary: "#C7A876",
    color_secondary: "#8B2E1F",
    material: "silk twill",
    season: ["spring", "fall"],
    formality_score: 6,
    tags: ["printed", "statement"],
  },
  {
    category: "dress",
    subcategory: "midi dress",
    color_primary: "#1C1C1C",
    color_secondary: null,
    material: "matte crepe",
    season: ["spring", "summer", "fall"],
    formality_score: 8,
    tags: ["sleeveless", "column", "evening"],
  },
];

export async function mockAnalyzeGarment(input: {
  user_id: string;
  item_id: string;
  enhanced_path: string;
}): Promise<GarmentAnalysis> {
  await delay();
  // Deterministic-ish picker so the same upload analyzes consistently.
  const seed = input.item_id
    .split("")
    .reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return ARCHETYPES[seed % ARCHETYPES.length];
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat — gpt-4o daily styling prompt
// ─────────────────────────────────────────────────────────────────────────────
export interface DailyPromptResult {
  prompt_text: string;
  context: {
    weather: string;
    temp_c: number;
    day_of_week: string;
    archetype: string | null;
  };
}

const PROMPTS = [
  "A {temp}°C {weather} {day} calls for unstructured tailoring — something you can walk the long way home in.",
  "Lean into texture today: a brushed wool, a worn leather, a hand that remembers it.",
  "The kind of {day} that asks for one good shirt and the discipline to leave the rest alone.",
  "Quiet colours, considered cuts. Let the weather do the talking.",
  "Something soft against something structured — that's the only rule today.",
  "A look built around shoes you actually want to walk in.",
];

export async function mockGenerateDailyPrompt(input: {
  user_id: string;
  temp_c: number;
  weather: string;
  day_of_week: string;
  archetype: string | null;
}): Promise<DailyPromptResult> {
  await delay();
  const template = PROMPTS[Math.floor(Math.random() * PROMPTS.length)];
  const prompt_text = template
    .replace("{temp}", String(Math.round(input.temp_c)))
    .replace("{weather}", input.weather.toLowerCase())
    .replace("{day}", input.day_of_week);
  return {
    prompt_text,
    context: {
      weather: input.weather,
      temp_c: input.temp_c,
      day_of_week: input.day_of_week,
      archetype: input.archetype,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI Chat — gpt-4o outfit composition
// ─────────────────────────────────────────────────────────────────────────────
export interface OutfitSuggestion {
  item_ids: string[];
  rationale: string;
  name: string;
}

export type Occasion =
  | "office"
  | "casual"
  | "evening"
  | "athletic"
  | "formal"
  | "travel";

interface CandidateItem {
  id: string;
  category: string | null;
  subcategory?: string | null;
  formality_score: number | null;
}

/**
 * Voice guide — rationale templates.
 *
 * DO: specific pieces, formality numbers, restraint, fragments.
 * DON'T: emoji, exclamation, "perfect", "stylish", "chic", "great",
 * "you'll look", second-person hype, hashtags.
 *
 * Tokens filled from real outfit data:
 *   {anchor}      — heaviest piece subcategory (outerwear or bottom)
 *   {top}         — top subcategory
 *   {shoes}       — shoes subcategory
 *   {formality}   — integer 1–10
 *   {temp}        — temperature in °C, integer
 */
const RATIONALE_TEMPLATES: Record<Occasion, string[]> = {
  office: [
    "The {anchor} anchors the look — appropriate for client days, never stiff.",
    "Formality lands at {formality}. The {shoes} keeps it human.",
    "Tailoring with give. The {top} does the rest.",
    "Built around the {anchor}. Quiet enough for a long meeting.",
    "Soft against structured. One considered move.",
  ],
  casual: [
    "Built around the {shoes}. Everything else recedes.",
    "Soft against structured. One considered move.",
    "The {top} carries it. Nothing here is asking for attention.",
    "{temp}° calls for ease, not effort. The {anchor} obliges.",
  ],
  evening: [
    "One loud note, the rest in shadow. The {top} catches light.",
    "Column silhouette. Formality at {formality} — restraint reads as the luxury.",
    "The {anchor} absorbs the room. You don't compete with it.",
    "Quiet drama. Texture over print, line over decoration.",
  ],
  athletic: [
    "Movement first, considered second. The {anchor} reads as form.",
    "Built to be worn hard. Quiet enough to stop for coffee in.",
    "{temp}° outside — the {top} handles it without fuss.",
  ],
  formal: [
    "The room will be louder than the clothes. Formality at {formality}.",
    "Architecture, not decoration. The {anchor} earns its place.",
    "Black tie translated into a softer dialect. Still serious.",
  ],
  travel: [
    "Wrinkle-resistant, layer-ready. The {anchor} is the uniform.",
    "Two airports, three time zones — the {top} still looks like itself.",
    "Engineered for transit. The {shoes} keeps the day moving.",
  ],
};

const NAMES: Record<Occasion, string[]> = {
  office: [
    "The Considered Monday",
    "Soft Power",
    "Quiet Authority",
    "The Long Meeting",
    "Studio Hours",
    "Oxford & Wool",
  ],
  casual: [
    "Slow Saturday",
    "The Walk Home",
    "Off-Duty",
    "Coffee, then Nothing",
    "The Easy One",
  ],
  evening: [
    "After Hours",
    "The Late Reservation",
    "Low Light",
    "Velvet Pretext",
    "One Drink",
  ],
  athletic: ["Morning Loop", "The Reset", "Ground Floor"],
  formal: ["The Address", "Black Tie, Softly", "Room of Strangers"],
  travel: ["Transit", "The Long Route", "Two Cities"],
};

const FORMALITY_RANGES: Record<Occasion, [number, number]> = {
  office: [6, 9],
  casual: [3, 6],
  evening: [7, 10],
  athletic: [1, 3],
  formal: [9, 10],
  travel: [3, 8],
};

// Strip voice violations that might sneak in (defense-in-depth).
const VOICE_BAN = /\s*(perfect|stylish|chic|amazing|fabulous|gorgeous|you['']ll look\s*\w*|great for\s*\w*|😎|🔥|✨|💯)\s*/gi;
function sanitizeVoice(text: string): string {
  let out = text.replace(VOICE_BAN, " ");
  // Replace exclamations with periods
  out = out.replace(/!+/g, ".");
  // Collapse whitespace and trim leading punctuation
  out = out.replace(/\s+/g, " ").replace(/^[\s.,—-]+/, "").trim();
  return out;
}

function fillTemplate(
  tpl: string,
  ctx: { anchor: string; top: string; shoes: string; formality: number; temp: number },
): string {
  const filled = tpl
    .replace(/{anchor}/g, ctx.anchor)
    .replace(/{top}/g, ctx.top)
    .replace(/{shoes}/g, ctx.shoes)
    .replace(/{formality}/g, String(Math.round(ctx.formality)))
    .replace(/{temp}/g, String(Math.round(ctx.temp)));
  return sanitizeVoice(filled);
}

function pickFromCategory(
  pool: CandidateItem[],
  category: string,
  range: [number, number],
  excludeIds: Set<string>,
): CandidateItem | null {
  const matches = pool.filter(
    (i) =>
      i.category === category &&
      !excludeIds.has(i.id) &&
      (i.formality_score == null ||
        (i.formality_score >= range[0] && i.formality_score <= range[1])),
  );
  if (!matches.length) return null;
  return matches[Math.floor(Math.random() * matches.length)];
}

function composeOne(
  pool: CandidateItem[],
  occasion: Occasion,
  used: Set<string>,
): CandidateItem[] | null {
  const range = FORMALITY_RANGES[occasion];
  const picked: CandidateItem[] = [];

  const dress = pickFromCategory(pool, "dress", range, used);
  if (dress && Math.random() < 0.35) {
    picked.push(dress);
  } else {
    const top = pickFromCategory(pool, "top", range, used);
    const bottom = pickFromCategory(pool, "bottom", range, used);
    if (!top || !bottom) {
      if (top) picked.push(top);
      if (bottom) picked.push(bottom);
    } else {
      picked.push(top, bottom);
    }
  }
  const shoes = pickFromCategory(pool, "shoes", range, used);
  if (shoes) picked.push(shoes);

  if (picked.length < 2) return null;

  const localUsed = new Set(picked.map((p) => p.id));
  const outer = pickFromCategory(pool, "outerwear", range, localUsed);
  if (outer && Math.random() < 0.6) {
    picked.push(outer);
    localUsed.add(outer.id);
  }
  const acc = pickFromCategory(pool, "accessory", range, localUsed);
  if (acc && Math.random() < 0.45) {
    picked.push(acc);
    localUsed.add(acc.id);
  }
  const bag = pickFromCategory(pool, "bag", range, localUsed);
  if (bag && Math.random() < 0.4) picked.push(bag);

  return picked;
}

function differsByAtLeast(a: string[], b: string[], n: number): boolean {
  const setB = new Set(b);
  const overlap = a.filter((x) => setB.has(x)).length;
  const diff = Math.max(a.length, b.length) - overlap;
  return diff >= n;
}

function buildRationale(
  template: string,
  picked: CandidateItem[],
  occasion: Occasion,
  temp_c: number,
): string {
  const find = (cat: string) => picked.find((p) => p.category === cat);
  const anchorItem = find("outerwear") || find("bottom") || find("dress") || picked[0];
  const topItem = find("top") || find("dress") || picked[0];
  const shoesItem = find("shoes") || picked[picked.length - 1];

  // Average formality of the look
  const scores = picked
    .map((p) => p.formality_score)
    .filter((s): s is number => s != null);
  const formality =
    scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : FORMALITY_RANGES[occasion][0];

  return fillTemplate(template, {
    anchor: anchorItem?.subcategory || anchorItem?.category || "piece",
    top: topItem?.subcategory || topItem?.category || "top",
    shoes: shoesItem?.subcategory || shoesItem?.category || "shoe",
    formality,
    temp: temp_c,
  });
}

export async function mockSuggestOutfit(input: {
  user_id: string;
  occasion: Occasion;
  temp_c: number;
  candidate_item_ids: string[];
  seed_item_id?: string;
}): Promise<OutfitSuggestion> {
  await delay();
  const count = Math.min(Math.max(3, input.candidate_item_ids.length), 5);
  const shuffled = [...input.candidate_item_ids].sort(() => Math.random() - 0.5);
  const item_ids = shuffled.slice(0, count);
  if (input.seed_item_id && !item_ids.includes(input.seed_item_id)) {
    item_ids[0] = input.seed_item_id;
  }
  const tplPool = RATIONALE_TEMPLATES[input.occasion];
  const namePool = NAMES[input.occasion];
  const tpl = tplPool[Math.floor(Math.random() * tplPool.length)];
  return {
    item_ids,
    rationale: sanitizeVoice(
      tpl
        .replace(/{anchor}/g, "piece")
        .replace(/{top}/g, "top")
        .replace(/{shoes}/g, "shoe")
        .replace(/{formality}/g, String(FORMALITY_RANGES[input.occasion][0]))
        .replace(/{temp}/g, String(Math.round(input.temp_c))),
    ),
    name: namePool[Math.floor(Math.random() * namePool.length)],
  };
}

/**
 * Generate up to N distinct outfits. Each outfit must differ from prior
 * outfits by at least 2 items. Returns however many distinct looks the
 * wardrobe can produce (1, 2, or 3). Rationales are filled with real
 * outfit details (anchor piece, formality average, temperature).
 */
export async function mockSuggestOutfits(input: {
  user_id: string;
  occasion: Occasion;
  temp_c: number;
  candidates: CandidateItem[];
  count: number;
  exclude_signatures?: string[][];
}): Promise<OutfitSuggestion[]> {
  await delay();
  const results: OutfitSuggestion[] = [];
  const tplPool = [...RATIONALE_TEMPLATES[input.occasion]].sort(
    () => Math.random() - 0.5,
  );
  const namePool = [...NAMES[input.occasion]].sort(() => Math.random() - 0.5);

  const priorSigs = input.exclude_signatures ?? [];
  let attempts = 0;
  const maxAttempts = 60;

  while (results.length < input.count && attempts < maxAttempts) {
    attempts++;
    const composed = composeOne(input.candidates, input.occasion, new Set());
    if (!composed) break;

    const ids = composed.map((c) => c.id);
    const allCheck = [...results.map((r) => r.item_ids), ...priorSigs];
    const ok = allCheck.every((other) => differsByAtLeast(ids, other, 2));
    if (!ok) continue;

    const tpl = tplPool[results.length % tplPool.length];
    results.push({
      item_ids: ids,
      rationale: buildRationale(tpl, composed, input.occasion, input.temp_c),
      name: namePool[results.length % namePool.length],
    });
  }

  return results;
}

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
  formality_score: number | null;
}

const RATIONALES: Record<Occasion, string[]> = {
  office: [
    "Tailoring with give. Formality lands at 7 — right for client days, relaxed enough to walk home in.",
    "The trousers anchor the look. The shirt does the rest. Quiet, considered.",
    "A shape that reads serious without trying. Built for rooms that matter.",
    "Structured shoulders, soft hand. The contradiction is the point.",
  ],
  casual: [
    "Built around the shoes. Everything else recedes — that's the brief.",
    "Soft against structured. Reads relaxed without becoming careless.",
    "Weekend tempo. Nothing here is asking for attention.",
    "The kind of ease that takes effort. Just not visibly.",
  ],
  evening: [
    "One loud note, the rest in shadow. The silk catches light.",
    "Column silhouette, single statement. Restraint is the luxury.",
    "Black absorbs the room. You don't compete with it — you let it work.",
    "Quiet drama. Texture over print, line over decoration.",
  ],
  athletic: [
    "Movement first, considered second. Function reading as form.",
    "Built to be worn hard. Quiet enough to stop for coffee in.",
    "Performance pieces in a palette that won't fight your watch.",
  ],
  formal: [
    "The room will be louder than the clothes. That's the point.",
    "Architecture, not decoration. Every line earns its place.",
    "Black tie translated into a softer dialect. Still serious.",
  ],
  travel: [
    "Wrinkle-resistant, layer-ready, one bag tested. The uniform.",
    "Two airports, three time zones — and you still look like yourself.",
    "Engineered to survive the journey. Designed to land elegant.",
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
): string[] | null {
  const range = FORMALITY_RANGES[occasion];
  const picked: CandidateItem[] = [];

  // Either dress OR top+bottom
  const dress = pickFromCategory(pool, "dress", range, used);
  if (dress && Math.random() < 0.35) {
    picked.push(dress);
  } else {
    const top = pickFromCategory(pool, "top", range, used);
    const bottom = pickFromCategory(pool, "bottom", range, used);
    if (!top || !bottom) {
      // Fallback: take any item to satisfy minimum
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
  // Optional outerwear
  const outer = pickFromCategory(pool, "outerwear", range, localUsed);
  if (outer && Math.random() < 0.6) picked.push(outer);
  localUsed.add(outer?.id ?? "");

  // Optional accessory & bag
  const acc = pickFromCategory(pool, "accessory", range, localUsed);
  if (acc && Math.random() < 0.45) picked.push(acc);
  if (acc) localUsed.add(acc.id);
  const bag = pickFromCategory(pool, "bag", range, localUsed);
  if (bag && Math.random() < 0.4) picked.push(bag);

  return picked.map((p) => p.id);
}

function differsByAtLeast(a: string[], b: string[], n: number): boolean {
  const setB = new Set(b);
  const overlap = a.filter((x) => setB.has(x)).length;
  const diff = Math.max(a.length, b.length) - overlap;
  return diff >= n;
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
  const pool = RATIONALES[input.occasion];
  const namePool = NAMES[input.occasion];
  return {
    item_ids,
    rationale: pool[Math.floor(Math.random() * pool.length)],
    name: namePool[Math.floor(Math.random() * namePool.length)],
  };
}

/**
 * Generate up to N distinct outfits. Each outfit must differ from prior
 * outfits by at least 2 items. Returns however many distinct looks the
 * wardrobe can produce (1, 2, or 3).
 */
export async function mockSuggestOutfits(input: {
  user_id: string;
  occasion: Occasion;
  temp_c: number;
  candidates: CandidateItem[];
  count: number;
  exclude_signatures?: string[][]; // prior item_ids arrays to differ from
}): Promise<OutfitSuggestion[]> {
  await delay();
  const results: OutfitSuggestion[] = [];
  const ratPool = [...RATIONALES[input.occasion]].sort(() => Math.random() - 0.5);
  const namePool = [...NAMES[input.occasion]].sort(() => Math.random() - 0.5);

  const priorSigs = input.exclude_signatures ?? [];
  let attempts = 0;
  const maxAttempts = 60;

  while (results.length < input.count && attempts < maxAttempts) {
    attempts++;
    const composed = composeOne(input.candidates, input.occasion, new Set());
    if (!composed) break;

    // Distinctness: differ from each accepted result and prior excludes by >= 2 items
    const allCheck = [
      ...results.map((r) => r.item_ids),
      ...priorSigs,
    ];
    const ok = allCheck.every((other) => differsByAtLeast(composed, other, 2));
    if (!ok) continue;

    results.push({
      item_ids: composed,
      rationale: ratPool[results.length % ratPool.length],
      name: namePool[results.length % namePool.length],
    });
  }

  return results;
}

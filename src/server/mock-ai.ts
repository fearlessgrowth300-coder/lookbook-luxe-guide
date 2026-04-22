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
}

export type Occasion =
  | "office"
  | "casual"
  | "evening"
  | "athletic"
  | "formal"
  | "travel";

const RATIONALES: Record<Occasion, string[]> = {
  office: [
    "The wool trousers anchor the look at a 7 — appropriate for client days, never stiff. The shirt does the rest.",
    "Tailoring with give. Formality lands at 7, the loafer keeps it human.",
  ],
  casual: [
    "Built around the shoes. Everything else recedes — that's the point.",
    "Soft against structured. Reads relaxed without becoming careless.",
  ],
  evening: [
    "One loud note, the rest in shadow. Black absorbs, the silk catches light.",
    "Column silhouette, single statement. Restraint is the luxury.",
  ],
  athletic: [
    "Movement first, considered second. Function reading as form.",
    "Built to be worn hard. Quiet enough to stop for coffee in.",
  ],
  formal: [
    "The room will be louder than the clothes. That's the brief.",
    "Architecture, not decoration. Every line earns its place.",
  ],
  travel: [
    "Wrinkle-resistant, layer-ready, one bag tested. The uniform.",
    "Two airports, three time zones — and you still look like yourself.",
  ],
};

export async function mockSuggestOutfit(input: {
  user_id: string;
  occasion: Occasion;
  temp_c: number;
  candidate_item_ids: string[];
  seed_item_id?: string;
}): Promise<OutfitSuggestion> {
  await delay();
  // Pick 3–5 items from candidates (pretend the LLM composed a look).
  const count = Math.min(
    Math.max(3, input.candidate_item_ids.length),
    5,
  );
  const shuffled = [...input.candidate_item_ids].sort(
    () => Math.random() - 0.5,
  );
  const item_ids = shuffled.slice(0, count);
  if (input.seed_item_id && !item_ids.includes(input.seed_item_id)) {
    item_ids[0] = input.seed_item_id;
  }
  const pool = RATIONALES[input.occasion];
  const rationale = pool[Math.floor(Math.random() * pool.length)];
  return { item_ids, rationale };
}

// Pinterest-derived style inspiration via Apify + Gemini vision.
// Server-only. Cached for 24h in `style_inspiration_cache` keyed by
// (occasion, mood, archetype) so repeat generations are instant + free.
//
// Failure mode: every error path returns `null` — the stylist falls back to
// its existing prompt unchanged. This is best-effort enrichment, never a
// hard dependency. Status is reported back so the UI can surface it.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { chatCompletion } from "./ai-gateway";

export interface InspirationPin {
  imageUrl: string;
}

export interface InspirationData {
  pin_count: number;
  palette: string[]; // human color names, e.g. ["camel", "ivory", "navy"]
  garments: string[]; // e.g. ["wool trouser", "cropped trench"]
  aesthetic_tags: string[]; // e.g. ["quiet luxury", "japanese minimal"]
}

export type InspirationStatus =
  | { state: "cached"; data: InspirationData; cache_age_hours: number }
  | { state: "fresh"; data: InspirationData; pins_scraped: number }
  | { state: "skipped"; reason: "no_apify_key" }
  | { state: "failed"; reason: string };

const APIFY_ACTOR = "epctex~pinterest-scraper"; // public Pinterest scraper actor
const APIFY_BASE = "https://api.apify.com/v2";
const SCRAPE_TIMEOUT_MS = 45_000;
const VISION_TIMEOUT_MS = 12_000;

function buildSearchQuery(args: {
  occasion: string;
  mood?: string | null;
  archetype: string;
}) {
  const moodPart = args.mood ? `${args.mood} ` : "";
  return `${moodPart}${args.archetype} ${args.occasion} outfit`.trim();
}

function buildCacheKey(args: {
  occasion: string;
  mood?: string | null;
  archetype: string;
}) {
  return [args.occasion, args.mood ?? "any", args.archetype]
    .map((s) => s.toLowerCase())
    .join("|");
}

interface CacheRow {
  cache_key: string;
  pin_count: number;
  palette: unknown;
  garments: unknown;
  aesthetic_tags: unknown;
  created_at: string;
  expires_at: string;
}

async function readCache(cacheKey: string): Promise<{
  data: InspirationData;
  cache_age_hours: number;
} | null> {
  const { data, error } = await (
    supabaseAdmin.from("style_inspiration_cache" as never) as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          gt: (col: string, val: string) => {
            maybeSingle: () => Promise<{ data: CacheRow | null; error: unknown }>;
          };
        };
      };
    }
  )
    .select("cache_key, pin_count, palette, garments, aesthetic_tags, created_at, expires_at")
    .eq("cache_key", cacheKey)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();

  if (error || !data) return null;

  const ageMs = Date.now() - new Date(data.created_at).getTime();
  return {
    data: {
      pin_count: data.pin_count,
      palette: Array.isArray(data.palette) ? (data.palette as string[]) : [],
      garments: Array.isArray(data.garments) ? (data.garments as string[]) : [],
      aesthetic_tags: Array.isArray(data.aesthetic_tags)
        ? (data.aesthetic_tags as string[])
        : [],
    },
    cache_age_hours: Math.floor(ageMs / 3_600_000),
  };
}

async function writeCache(
  cacheKey: string,
  args: { occasion: string; mood?: string | null; archetype: string },
  payload: InspirationData,
) {
  await (
    supabaseAdmin.from("style_inspiration_cache" as never) as unknown as {
      upsert: (row: Record<string, unknown>) => Promise<{ error: unknown }>;
    }
  ).upsert({
    cache_key: cacheKey,
    occasion: args.occasion,
    mood: args.mood ?? null,
    archetype: args.archetype,
    pin_count: payload.pin_count,
    palette: payload.palette,
    garments: payload.garments,
    aesthetic_tags: payload.aesthetic_tags,
    source: "apify_pinterest",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
  });
}

/**
 * Run the Apify Pinterest actor synchronously and return up to `limit` image URLs.
 * Uses run-sync-get-dataset-items so we don't have to poll a run id.
 */
async function scrapePinterest(
  query: string,
  limit: number,
): Promise<InspirationPin[]> {
  const apiKey = process.env.APIFY_API_KEY;
  if (!apiKey) throw new Error("no_apify_key");

  const url = `${APIFY_BASE}/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?token=${apiKey}&timeout=40`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        startUrls: [
          { url: `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}` },
        ],
        proxy: { useApifyProxy: true },
        endPage: 1,
        searchLimit: limit,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("apify_timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`apify_${resp.status}:${body.slice(0, 120)}`);
  }

  const items = (await resp.json()) as unknown;
  if (!Array.isArray(items)) return [];

  const pins: InspirationPin[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    // Different actor versions use different keys — try common ones.
    const candidate =
      (typeof rec.imageUrl === "string" && rec.imageUrl) ||
      (typeof rec.image === "string" && rec.image) ||
      (rec.images &&
        typeof rec.images === "object" &&
        ((rec.images as Record<string, { url?: string }>).orig?.url ??
          (rec.images as Record<string, { url?: string }>)["736x"]?.url)) ||
      null;
    if (typeof candidate === "string" && candidate.startsWith("http")) {
      pins.push({ imageUrl: candidate });
      if (pins.length >= limit) break;
    }
  }
  return pins;
}

interface VisionExtraction {
  palette: string[];
  garments: string[];
  aesthetic_tags: string[];
}

async function extractFromPin(
  imageUrl: string,
  archetype: string,
): Promise<VisionExtraction | null> {
  try {
    const raw = await chatCompletion({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content:
            'You analyze fashion outfit photos. Return strict JSON only — no prose, no markdown.',
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this ${archetype} outfit. Return JSON:\n{\n  "palette": ["color1","color2",...] (2-4 human color names like "camel","navy","ivory"),\n  "garments": ["item1","item2",...] (2-4 short garment phrases like "wool trouser","cropped trench"),\n  "aesthetic_tags": ["tag1","tag2"] (1-3 short style tags like "quiet luxury","minimal")\n}`,
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 200,
      json: true,
      timeoutMs: VISION_TIMEOUT_MS,
    });
    const parsed = JSON.parse(raw) as Partial<VisionExtraction>;
    return {
      palette: Array.isArray(parsed.palette)
        ? parsed.palette.filter((s) => typeof s === "string").slice(0, 4)
        : [],
      garments: Array.isArray(parsed.garments)
        ? parsed.garments.filter((s) => typeof s === "string").slice(0, 4)
        : [],
      aesthetic_tags: Array.isArray(parsed.aesthetic_tags)
        ? parsed.aesthetic_tags.filter((s) => typeof s === "string").slice(0, 3)
        : [],
    };
  } catch (err) {
    console.warn("[inspiration] vision extraction failed:", (err as Error).message);
    return null;
  }
}

function aggregate(extractions: VisionExtraction[]): {
  palette: string[];
  garments: string[];
  aesthetic_tags: string[];
} {
  const tally = (key: keyof VisionExtraction) => {
    const counts = new Map<string, number>();
    for (const ex of extractions) {
      for (const v of ex[key]) {
        const norm = v.toLowerCase().trim();
        if (!norm) continue;
        counts.set(norm, (counts.get(norm) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([v]) => v);
  };
  return {
    palette: tally("palette").slice(0, 6),
    garments: tally("garments").slice(0, 8),
    aesthetic_tags: tally("aesthetic_tags").slice(0, 5),
  };
}

/**
 * Fetch (or scrape + extract + cache) Pinterest inspiration for the
 * given styling context. NEVER throws — all failures degrade to
 * `state: "failed"` so the stylist can proceed unimpeded.
 */
export async function getInspiration(args: {
  occasion: string;
  mood?: string | null;
  archetype: string;
}): Promise<InspirationStatus> {
  if (!process.env.APIFY_API_KEY) {
    return { state: "skipped", reason: "no_apify_key" };
  }

  const cacheKey = buildCacheKey(args);

  try {
    const cached = await readCache(cacheKey);
    if (cached) {
      return { state: "cached", data: cached.data, cache_age_hours: cached.cache_age_hours };
    }
  } catch (err) {
    console.warn("[inspiration] cache read failed:", (err as Error).message);
  }

  try {
    const query = buildSearchQuery(args);
    console.log("[inspiration] scraping Pinterest for:", query);
    const pins = await scrapePinterest(query, 8);
    if (pins.length === 0) {
      return { state: "failed", reason: "no_pins_returned" };
    }

    const extractions = (
      await Promise.all(
        pins.slice(0, 6).map((p) => extractFromPin(p.imageUrl, args.archetype)),
      )
    ).filter((x): x is VisionExtraction => x !== null);

    if (extractions.length === 0) {
      return { state: "failed", reason: "no_vision_extractions" };
    }

    const aggregated = aggregate(extractions);
    const data: InspirationData = {
      pin_count: extractions.length,
      ...aggregated,
    };

    try {
      await writeCache(cacheKey, args, data);
    } catch (err) {
      console.warn("[inspiration] cache write failed:", (err as Error).message);
    }

    return { state: "fresh", data, pins_scraped: pins.length };
  } catch (err) {
    const msg = (err as Error).message ?? "unknown";
    console.warn("[inspiration] failed:", msg);
    return { state: "failed", reason: msg.slice(0, 80) };
  }
}

/**
 * Format inspiration data as a short prompt fragment to inject into the
 * stylist user prompt. Returns an empty string when there's nothing useful.
 */
export function inspirationPromptFragment(status: InspirationStatus): string {
  if (status.state !== "cached" && status.state !== "fresh") return "";
  const { palette, garments, aesthetic_tags, pin_count } = status.data;
  if (palette.length === 0 && garments.length === 0 && aesthetic_tags.length === 0) {
    return "";
  }
  const parts: string[] = [];
  if (palette.length > 0) parts.push(`color palettes seen: ${palette.join(", ")}`);
  if (garments.length > 0) parts.push(`garment combinations seen: ${garments.join(", ")}`);
  if (aesthetic_tags.length > 0) parts.push(`aesthetic tags: ${aesthetic_tags.join(", ")}`);

  return `\n\n**Real-world inspiration** (drawn from ${pin_count} curated reference outfits): ${parts.join("; ")}.\nBorrow color combinations and proportion ideas where they fit the user's wardrobe — do NOT force a palette that conflicts with what's actually available.`;
}

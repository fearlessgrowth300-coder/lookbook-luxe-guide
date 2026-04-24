// Convert a hex color (e.g. "#727B5C") to the nearest human fashion color name
// using CIE76 distance in LAB space. Used by the AI prompt builder so the LLM
// can reference items by human color names ("olive cargo pants") instead of
// echoing raw hex values into rationale strings.

interface NamedColor {
  name: string;
  hex: string;
  lab: [number, number, number];
}

// Curated palette focused on fashion neutrals + common accents.
const PALETTE: { name: string; hex: string }[] = [
  // Neutrals
  { name: "black", hex: "#1A1A1A" },
  { name: "charcoal", hex: "#36383C" },
  { name: "graphite", hex: "#4A4D52" },
  { name: "slate", hex: "#5C6470" },
  { name: "stone", hex: "#A09A8E" },
  { name: "taupe", hex: "#8B7E6E" },
  { name: "ash", hex: "#9A9893" },
  { name: "dove", hex: "#C5C2BC" },
  { name: "oatmeal", hex: "#D7CDB8" },
  { name: "cream", hex: "#EFE7D5" },
  { name: "ivory", hex: "#F4EFE3" },
  { name: "white", hex: "#F5F5F2" },
  { name: "off-white", hex: "#E8E4D8" },
  { name: "bone", hex: "#E2DCC8" },
  { name: "ecru", hex: "#D4C8AE" },
  { name: "sand", hex: "#C7B89A" },
  { name: "khaki", hex: "#A89A75" },
  { name: "camel", hex: "#C19A6B" },
  { name: "tan", hex: "#B08D5B" },
  { name: "cognac", hex: "#8B5A2B" },
  { name: "chocolate", hex: "#4E2E1F" },
  { name: "espresso", hex: "#3B2418" },
  { name: "brown", hex: "#5C3A23" },

  // Blues
  { name: "navy", hex: "#1C2436" },
  { name: "midnight", hex: "#0F1626" },
  { name: "indigo", hex: "#2A3A66" },
  { name: "denim", hex: "#3F5775" },
  { name: "steel", hex: "#5C7088" },
  { name: "sky", hex: "#8FB1C6" },
  { name: "powder", hex: "#BFD3DD" },

  // Greens
  { name: "forest", hex: "#2A3F2A" },
  { name: "olive", hex: "#727B5C" },
  { name: "sage", hex: "#A4AC95" },
  { name: "moss", hex: "#5E6B45" },
  { name: "seafoam", hex: "#A8C8B5" },

  // Reds / warm
  { name: "burgundy", hex: "#5C1F2B" },
  { name: "wine", hex: "#722F3C" },
  { name: "brick", hex: "#8B3A2E" },
  { name: "rust", hex: "#A0522D" },
  { name: "terracotta", hex: "#B36A4A" },
  { name: "coral", hex: "#D88574" },
  { name: "blush", hex: "#E5C0B6" },
  { name: "red", hex: "#A02828" },

  // Yellows / warm
  { name: "mustard", hex: "#B58A2A" },
  { name: "ochre", hex: "#C29438" },
  { name: "butter", hex: "#E8D89A" },

  // Purples / pinks
  { name: "plum", hex: "#5C3A55" },
  { name: "mauve", hex: "#9C7889" },
  { name: "rose", hex: "#C49AA0" },
  { name: "pink", hex: "#D9A8B5" },
];

function hexToRgb(hex: string): [number, number, number] | null {
  const cleaned = hex.replace(/^#/, "").trim();
  if (cleaned.length !== 6 && cleaned.length !== 3) return null;
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return null;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// sRGB → linear → XYZ (D65) → LAB. Standard Bruce Lindbloom math.
function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const srgb = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  const [lr, lg, lb] = srgb;
  // sRGB D65 → XYZ
  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
  const z = lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041;
  // Reference white D65
  const xn = x / 0.95047;
  const yn = y / 1.0;
  const zn = z / 1.08883;
  const f = (t: number) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(xn);
  const fy = f(yn);
  const fz = f(zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const PALETTE_LAB: NamedColor[] = PALETTE.map((p) => {
  const rgb = hexToRgb(p.hex)!;
  return { ...p, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) };
});

function deltaE76(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Convert a hex string to the nearest named fashion color.
 * - Returns null for invalid input.
 * - If the input is already a recognizable plain word (e.g. "navy"), returns it
 *   lowercased so callers can pass either format safely.
 */
export function hexToColorName(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If it doesn't start with # and isn't 6 hex chars, treat as already-named.
  if (!/^#?[0-9a-f]{3,6}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  const rgb = hexToRgb(trimmed);
  if (!rgb) return trimmed.toLowerCase();
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);

  let best: NamedColor | null = null;
  let bestD = Infinity;
  for (const candidate of PALETTE_LAB) {
    const d = deltaE76(lab, candidate.lab);
    if (d < bestD) {
      bestD = d;
      best = candidate;
    }
  }
  return best?.name ?? null;
}

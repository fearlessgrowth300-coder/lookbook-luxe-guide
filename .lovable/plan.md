
# Stylist overhaul — 4 fixes

This is a large change with both UI and backend work. Plan is split so you can approve all of it or pick parts.

## Fix 1 — Same shoe every time

**1a. Manual formality override in wardrobe edit sheet**
- Open the wardrobe item edit sheet (currently in `src/routes/wardrobe.tsx` / its sheet component). Add a Formality control showing the vision-detected score plus three pills (Casual 3 / Smart 6 / Formal 9) and a 1–10 slider. On change, write `formality_score` to `wardrobe_items` immediately.
- Label: "Vision detected: {score}".

**1b. Adaptive shoe candidate pool**
- In `suggestOutfit.ts`, before composing: pull shoes filtered by occasion's formality range. If <2 pass, expand by ±2. If still 1, keep it but inject a note into the prompt explaining only one shoe is available.

**1c. Real freshness weighting**
- Replace the existing `candidatePriorityScore` weighting with explicit weighted random selection per category (top, bottom, shoes, outerwear).
- Weights: ×0.2 if worn in last 7 days, ×0.1 if last 3 days, ×0.4 if `wear_count > 2× category average`.
- Use this to pre-trim the shortlist passed to the AI so the LLM cannot ignore wear data.

## Fix 2 — Variety across generates in same session

**2a. Session batch tracking (frontend)**
- Add `todayBatchIds: string[]` to `useUI`/new `useStylerSession` Zustand store. On each successful generate, push the new batch_id (cap to last 3).

**2b. Server exclusion**
- Extend `SuggestInput` with `exclude_recent_batch_ids?: string[]`. Fetch outfits for those batches, build a frequency map, and remove items that appear in all 3 recent batches from the candidate pool. Items in 2/3 get a soft penalty in the weighting.

**2c. Variety prompt rule**
- Add explicit "differ by ≥3 items, not 2" rule to user prompt with the recent look summaries.

## Fix 3 — Replace Pinterest with style DNA

**3a. Remove Pinterest**
- Delete `src/server/lib/inspiration.ts` Apify/Pinterest code paths. Remove `inspirationFragment` wiring from `suggestOutfit.ts`. Drop the broken cache calls. Keep the cache table for now (no migration) — just stop reading/writing.

**3b. Style DNA picker in settings**
- Add migration: `profiles.inspiration_dna text[] default '{}'`.
- New section in `src/routes/settings.tsx`: 3×4 grid of curated images. Tapping toggles selection; selected = champagne ring. Each image has hidden tags.
- Need 12 curated editorial images for `/public/styles/`. **I'll generate these with the image tool unless you have your own.**
- Save merged tags to `profiles.inspiration_dna`.

**3c. Pass DNA to stylist prompt**
- Inject `inspiration_dna` into user prompt with the example guidance from your spec.

**3d. (Skipped) Web-search trend signal** — not doing this in v1; we can add later. Confirm if you want it now.

## Fix 4 — System prompt overhaul (Marcus Chen)

**4a. Replace SYSTEM_PROMPT entirely** in `suggestOutfit.ts` with the Marcus Chen prompt verbatim from your spec.

**4b. Restructure user prompt**
- List shoes SEPARATELY at the top (id, subcategory, formality, color_name).
- List other candidates below.
- Include: occasion, temp_c, humidity (if available — currently not fetched, will pass null), precipitation (null for now), day_of_week, mood, archetype, inspiration_dna, recent look summaries, winning/losing pairs (`null` for now — no rating data wired yet).
- Output schema updated to match Marcus Chen format (`reasoning.shoe_strategy`, `details.color_story`, etc.).

**4c. Server-side shoe distribution check**
- After validation: if all 3 looks share one shoe AND ≥2 shoes were available, retry once with feedback "Distribute shoes across looks."

## What I'm explicitly NOT doing (confirm if you want)
- Humidity/precipitation: `generateDailyPrompt` fetches weather; `suggestOutfit` does not. Wiring humidity in needs a weather call inside `suggestOutfit` or passing it from the client. Skip for v1.
- Winning/losing pairs: no rating UI exists yet. Skip.
- Web search trend signal in daily prompt: skip.
- I'll generate 12 mood images with the image tool if you don't provide them.

## Files touched
- `src/server/functions/suggestOutfit.ts` (system prompt, user prompt, shoe pool, weighted selection, exclusion, shoe distribution check)
- `src/routes/wardrobe.tsx` and its edit sheet (formality override)
- `src/routes/settings.tsx` (style DNA picker)
- `src/routes/today.tsx` and `src/components/ThreeLooksSheet.tsx` (pass `exclude_recent_batch_ids`)
- `src/lib/store.ts` (session batch tracking)
- `src/server/lib/inspiration.ts` (gut Pinterest path)
- New: `public/styles/*.jpg` (12 generated images) + `src/lib/style-dna.ts` (image+tag manifest)
- DB migration: `profiles.inspiration_dna text[]`

Approve and I'll execute all of it. Or tell me which fixes to skip.

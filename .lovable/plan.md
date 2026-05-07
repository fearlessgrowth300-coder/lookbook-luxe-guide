# Stop the "same dress every time" problem

## What's happening

When you tap **Office → Generate**, the server runs the same logic with the same inputs every time:

- It never looks at what you've already been suggested.
- The "compose different looks" hint to the AI is vague — it doesn't list the looks to avoid.
- When the AI fails or the wardrobe is small, a deterministic fallback picks the highest-scoring combo, which is always the same dress + the same shoes.
- Items recently worn / recently suggested aren't penalised hard enough to shift the result.

Your wardrobe right now: 21 tops, 13 bottoms, **1 outerwear, 3 shoes** — so shoe and outerwear repetition is unavoidable, but the *combination* should clearly rotate.

## The plan

### 1. Track recent looks per occasion
On the server, before composing, fetch the **last 10 outfits** the user has generated for the same occasion in the last 7 days (`outfits` table, filter by `user_id + occasion`, order by `generated_at desc`). Extract their `item_ids` arrays as **prior signatures**.

### 2. Tell the AI exactly what to avoid
Pass the prior signatures into the prompt explicitly:

```
You recently proposed these looks for this occasion. Do NOT repeat them
and do NOT propose looks that share more than 1 item with any of them:
- Look A: [id1, id2, id3]
- Look B: [id4, id5, id6]
...
```

Then validate it server-side: any returned look that overlaps a prior signature by 2+ items is rejected and the AI is asked again (currently `MAX_AI_ATTEMPTS = 1`; bump to 2 so a retry is possible).

### 3. Make the heuristic fallback non-deterministic
Today the fallback (`buildHeuristicLooks`) sorts combos by score and picks the top 3 — same inputs → same output. Change it to:

- Heavily penalise items appearing in prior signatures (e.g. `−15` per overlap).
- Heavily penalise items with high `wear_count` and recent `last_worn` (already partially done; raise the weight).
- Add a small random jitter to the score so ties break differently each call.
- Reject any candidate combo that overlaps any prior signature by 2+ items.

### 4. Wire `exclude_batch_id` from the UI
Currently `today.tsx` calls `suggestOutfit` without `exclude_batch_id`. Pass the most recent batch_id for the same occasion so the server has an explicit "this is the one you just showed me, don't repeat it" anchor.

### 5. Better empty-state message
If the wardrobe is genuinely too small to produce a fresh look (e.g. only 1 valid combo exists), return a clear message: *"Only one office combination fits your current wardrobe. Add another pair of shoes or a second bottom to unlock variety."* — instead of silently re-serving the same look.

## Technical details

Files touched:
- `src/server/functions/suggestOutfit.ts` — fetch prior outfits, inject prior signatures into prompt + validator, raise wear penalty, jitter score, reject overlapping fallback combos, bump retry to 2.
- `src/routes/today.tsx` — query latest outfit for the selected occasion and pass `exclude_batch_id`.
- (Optional) `src/components/ThreeLooksSheet.tsx` — same exclusion wiring for the regenerate-in-sheet flow.

No DB migration needed. No new dependencies.

## Result

Each tap on **Generate** for the same occasion will produce a look that differs from your last 10 looks by at least 2 items — until your wardrobe genuinely runs out of fresh combinations, in which case you'll get a clear message explaining why.

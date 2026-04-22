
-- Replace broad public read with a no-op-listing policy.
-- Public buckets allow anonymous GET on individual object URLs even without a SELECT policy,
-- so dropping the broad SELECT prevents listing while keeping direct file URLs accessible.
drop policy if exists "thumbs public read" on storage.objects;

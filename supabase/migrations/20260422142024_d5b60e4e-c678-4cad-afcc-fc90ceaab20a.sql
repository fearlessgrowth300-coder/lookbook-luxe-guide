-- Add missing SELECT policy for thumbs (so the gallery can render owned thumbs)
create policy "own thumbs select"
on storage.objects for select
using (
  bucket_id = 'wardrobe-thumbs'
  and (auth.uid())::text = (storage.foldername(name))[1]
);

-- Fix UPDATE policy on thumbs: needs with_check so upsert can rewrite the row
drop policy if exists "own thumbs update" on storage.objects;
create policy "own thumbs update"
on storage.objects for update
using (
  bucket_id = 'wardrobe-thumbs'
  and (auth.uid())::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'wardrobe-thumbs'
  and (auth.uid())::text = (storage.foldername(name))[1]
);

-- Add UPDATE policy for raw bucket so upserts work
create policy "own raw update"
on storage.objects for update
using (
  bucket_id = 'wardrobe-raw'
  and (auth.uid())::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'wardrobe-raw'
  and (auth.uid())::text = (storage.foldername(name))[1]
);

-- Add UPDATE + DELETE policies for enhanced bucket
create policy "own enhanced update"
on storage.objects for update
using (
  bucket_id = 'wardrobe-enhanced'
  and (auth.uid())::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'wardrobe-enhanced'
  and (auth.uid())::text = (storage.foldername(name))[1]
);

create policy "own enhanced delete"
on storage.objects for delete
using (
  bucket_id = 'wardrobe-enhanced'
  and (auth.uid())::text = (storage.foldername(name))[1]
);
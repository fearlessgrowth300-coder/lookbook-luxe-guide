
-- 1. Add render_path to outfits
ALTER TABLE public.outfits
ADD COLUMN IF NOT EXISTS render_path text,
ADD COLUMN IF NOT EXISTS render_status text DEFAULT 'pending';

-- 2. Create public bucket for rendered outfit images
INSERT INTO storage.buckets (id, name, public)
VALUES ('outfit-renders', 'outfit-renders', true)
ON CONFLICT (id) DO NOTHING;

-- 3. Storage policies
DROP POLICY IF EXISTS "outfit-renders public read" ON storage.objects;
CREATE POLICY "outfit-renders public read"
ON storage.objects FOR SELECT
USING (bucket_id = 'outfit-renders');

DROP POLICY IF EXISTS "outfit-renders user write" ON storage.objects;
CREATE POLICY "outfit-renders user write"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'outfit-renders'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "outfit-renders user update" ON storage.objects;
CREATE POLICY "outfit-renders user update"
ON storage.objects FOR UPDATE
TO authenticated
USING (
  bucket_id = 'outfit-renders'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "outfit-renders user delete" ON storage.objects;
CREATE POLICY "outfit-renders user delete"
ON storage.objects FOR DELETE
TO authenticated
USING (
  bucket_id = 'outfit-renders'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

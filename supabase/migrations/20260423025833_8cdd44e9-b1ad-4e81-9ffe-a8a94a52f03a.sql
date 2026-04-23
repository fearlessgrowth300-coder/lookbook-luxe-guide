-- Add reference photo column to profiles
ALTER TABLE public.profiles
ADD COLUMN IF NOT EXISTS reference_photo_path text;

-- Create private storage bucket for user reference photos
INSERT INTO storage.buckets (id, name, public)
VALUES ('user-references', 'user-references', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policies: users can manage their own folder (named by user id)
CREATE POLICY "ref own select"
ON storage.objects FOR SELECT
USING (bucket_id = 'user-references' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "ref own insert"
ON storage.objects FOR INSERT
WITH CHECK (bucket_id = 'user-references' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "ref own update"
ON storage.objects FOR UPDATE
USING (bucket_id = 'user-references' AND auth.uid()::text = (storage.foldername(name))[1]);

CREATE POLICY "ref own delete"
ON storage.objects FOR DELETE
USING (bucket_id = 'user-references' AND auth.uid()::text = (storage.foldername(name))[1]);
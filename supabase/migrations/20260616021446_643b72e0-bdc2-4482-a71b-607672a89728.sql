
-- ai_usage write policies
CREATE POLICY "own usage insert" ON public.ai_usage FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own usage update" ON public.ai_usage FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own usage delete" ON public.ai_usage FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- styling_logs write policies
CREATE POLICY "own logs insert" ON public.styling_logs FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own logs update" ON public.styling_logs FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own logs delete" ON public.styling_logs FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- outfit-renders: replace broad public SELECT with owner-scoped authenticated SELECT
DROP POLICY IF EXISTS "outfit-renders public read" ON storage.objects;
CREATE POLICY "outfit-renders user read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'outfit-renders' AND (auth.uid())::text = (storage.foldername(name))[1]);

-- Realtime: restrict topic subscription to owner of wardrobe_items
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "wardrobe_items own topic" ON realtime.messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.wardrobe_items wi
      WHERE wi.user_id = auth.uid()
        AND realtime.topic() = 'wardrobe_items:' || wi.user_id::text
    )
  );

-- Revoke EXECUTE on increment_ai_usage from anon/authenticated; keep service_role
REVOKE EXECUTE ON FUNCTION public.increment_ai_usage(uuid, text, date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_ai_usage(uuid, text, date, integer) TO service_role;

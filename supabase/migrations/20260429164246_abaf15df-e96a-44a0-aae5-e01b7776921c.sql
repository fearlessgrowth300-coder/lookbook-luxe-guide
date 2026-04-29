ALTER TABLE public.wardrobe_items
  ADD COLUMN IF NOT EXISTS is_dirty boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS dirty_since timestamp with time zone;

CREATE INDEX IF NOT EXISTS idx_wardrobe_items_user_dirty
  ON public.wardrobe_items (user_id, is_dirty)
  WHERE archived = false;
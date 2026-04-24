ALTER TABLE public.outfits
ADD COLUMN IF NOT EXISTS mannequin_path text,
ADD COLUMN IF NOT EXISTS mannequin_status text DEFAULT 'idle',
ADD COLUMN IF NOT EXISTS mannequin_error text;
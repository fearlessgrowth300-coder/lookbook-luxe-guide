alter table public.outfits add column if not exists name text;
alter table public.outfits add column if not exists look_sequence int;
alter table public.outfits add column if not exists batch_id uuid;

create index if not exists outfits_batch_id_idx on public.outfits (batch_id);
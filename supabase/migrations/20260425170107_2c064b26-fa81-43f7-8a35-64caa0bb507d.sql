-- Garment sets table
create table if not exists public.garment_sets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text,
  set_type text check (set_type in (
    'suit',
    '3piece_suit',
    'agbada',
    'kaftan',
    'two_piece',
    'tracksuit',
    'ankara_set',
    'other'
  )),
  formality_score int check (formality_score between 1 and 10),
  occasion_tags text[] not null default '{}',
  must_wear_complete boolean not null default true,
  separable_pieces text[] not null default '{}',
  cultural_context text,
  season text[] not null default '{}',
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists garment_sets_user_archived_idx
  on public.garment_sets (user_id, archived);

alter table public.garment_sets enable row level security;

create policy "own sets select"
  on public.garment_sets for select
  using (auth.uid() = user_id);

create policy "own sets insert"
  on public.garment_sets for insert
  with check (auth.uid() = user_id);

create policy "own sets update"
  on public.garment_sets for update
  using (auth.uid() = user_id);

create policy "own sets delete"
  on public.garment_sets for delete
  using (auth.uid() = user_id);

-- Link wardrobe_items to sets
alter table public.wardrobe_items
  add column if not exists set_id uuid references public.garment_sets(id) on delete set null,
  add column if not exists set_role text check (set_role in (
    'jacket', 'trouser', 'waistcoat', 'shirt',
    'agbada_robe', 'buba_top', 'sokoto_trouser',
    'kaftan_top', 'kaftan_bottom',
    'tracksuit_top', 'tracksuit_bottom',
    'top', 'bottom', 'overlay'
  ));

create index if not exists wardrobe_items_set_id_idx
  on public.wardrobe_items (set_id);
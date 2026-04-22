
-- Profiles table
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text,
  style_archetype text check (style_archetype in ('minimalist','classic','eclectic','romantic','edgy','sporty')),
  climate text check (climate in ('tropical','temperate','continental','cold')),
  avoid_colors text[] default '{}',
  favorite_colors text[] default '{}',
  created_at timestamptz default now()
);

create table public.wardrobe_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  raw_path text not null,
  enhanced_path text,
  thumbnail_path text,
  placeholder text,
  category text check (category in ('top','bottom','outerwear','dress','shoes','accessory','bag')),
  subcategory text,
  color_primary text,
  color_secondary text,
  material text,
  season text[] default '{}',
  formality_score int check (formality_score between 1 and 10),
  tags text[] default '{}',
  last_worn timestamptz,
  wear_count int default 0,
  archived boolean default false,
  created_at timestamptz default now()
);
create index on public.wardrobe_items(user_id, archived);
create index on public.wardrobe_items(user_id, category);

create table public.outfits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  item_ids uuid[] not null,
  occasion text check (occasion in ('office','casual','evening','athletic','formal','travel')),
  context jsonb,
  rationale text,
  user_rating int check (user_rating between 1 and 5),
  saved boolean default false,
  worn_on date,
  generated_at timestamptz default now()
);
create index on public.outfits(user_id, generated_at desc);

create table public.daily_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  prompt_date date not null,
  prompt_text text not null,
  context jsonb,
  unique(user_id, prompt_date)
);

-- RLS
alter table public.profiles enable row level security;
alter table public.wardrobe_items enable row level security;
alter table public.outfits enable row level security;
alter table public.daily_prompts enable row level security;

create policy "own profile select" on public.profiles for select using (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);
create policy "own profile update" on public.profiles for update using (auth.uid() = id);
create policy "own profile delete" on public.profiles for delete using (auth.uid() = id);

create policy "own wardrobe select" on public.wardrobe_items for select using (auth.uid() = user_id);
create policy "own wardrobe insert" on public.wardrobe_items for insert with check (auth.uid() = user_id);
create policy "own wardrobe update" on public.wardrobe_items for update using (auth.uid() = user_id);
create policy "own wardrobe delete" on public.wardrobe_items for delete using (auth.uid() = user_id);

create policy "own outfits select" on public.outfits for select using (auth.uid() = user_id);
create policy "own outfits insert" on public.outfits for insert with check (auth.uid() = user_id);
create policy "own outfits update" on public.outfits for update using (auth.uid() = user_id);
create policy "own outfits delete" on public.outfits for delete using (auth.uid() = user_id);

create policy "own prompts select" on public.daily_prompts for select using (auth.uid() = user_id);
create policy "own prompts insert" on public.daily_prompts for insert with check (auth.uid() = user_id);
create policy "own prompts update" on public.daily_prompts for update using (auth.uid() = user_id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Storage buckets
insert into storage.buckets (id, name, public) values
  ('wardrobe-raw', 'wardrobe-raw', false),
  ('wardrobe-enhanced', 'wardrobe-enhanced', false),
  ('wardrobe-thumbs', 'wardrobe-thumbs', true);

-- Storage policies: users can manage their own files (path starts with user_id/)
create policy "own raw select" on storage.objects for select
  using (bucket_id = 'wardrobe-raw' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own raw insert" on storage.objects for insert
  with check (bucket_id = 'wardrobe-raw' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own raw delete" on storage.objects for delete
  using (bucket_id = 'wardrobe-raw' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "own enhanced select" on storage.objects for select
  using (bucket_id = 'wardrobe-enhanced' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own enhanced insert" on storage.objects for insert
  with check (bucket_id = 'wardrobe-enhanced' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "thumbs public read" on storage.objects for select
  using (bucket_id = 'wardrobe-thumbs');
create policy "own thumbs insert" on storage.objects for insert
  with check (bucket_id = 'wardrobe-thumbs' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own thumbs update" on storage.objects for update
  using (bucket_id = 'wardrobe-thumbs' and auth.uid()::text = (storage.foldername(name))[1]);
create policy "own thumbs delete" on storage.objects for delete
  using (bucket_id = 'wardrobe-thumbs' and auth.uid()::text = (storage.foldername(name))[1]);

-- Enable realtime for wardrobe_items so UI can subscribe to enhancement updates
alter publication supabase_realtime add table public.wardrobe_items;
alter table public.wardrobe_items replica identity full;

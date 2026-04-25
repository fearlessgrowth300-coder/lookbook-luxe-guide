create table public.style_inspiration_cache (
  cache_key text primary key,
  occasion text not null,
  mood text,
  archetype text,
  pin_count int not null default 0,
  palette jsonb not null default '[]'::jsonb,
  garments jsonb not null default '[]'::jsonb,
  aesthetic_tags jsonb not null default '[]'::jsonb,
  source text not null default 'apify_pinterest',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

create index style_inspiration_cache_expires_at_idx
  on public.style_inspiration_cache (expires_at);

alter table public.style_inspiration_cache enable row level security;

create policy "authenticated can read inspiration cache"
on public.style_inspiration_cache
for select
to authenticated
using (true);

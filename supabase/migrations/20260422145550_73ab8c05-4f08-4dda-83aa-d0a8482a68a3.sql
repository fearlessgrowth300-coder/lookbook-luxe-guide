create table if not exists public.styling_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  batch_id uuid,
  occasion text,
  temp_c int,
  mood text,
  archetype text,
  reasoning jsonb,
  wardrobe_size int,
  candidate_size int,
  created_at timestamptz not null default now()
);

alter table public.styling_logs enable row level security;

create policy "own logs select"
  on public.styling_logs
  for select
  using (auth.uid() = user_id);

create index if not exists styling_logs_user_created_idx
  on public.styling_logs (user_id, created_at desc);
create index if not exists styling_logs_batch_idx
  on public.styling_logs (batch_id);
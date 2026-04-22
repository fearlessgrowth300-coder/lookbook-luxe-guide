-- Track AI function usage per user per day for rate limiting
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users on delete cascade,
  day date not null,
  function_name text not null,
  count int not null default 0,
  primary key (user_id, day, function_name)
);

alter table public.ai_usage enable row level security;

-- Users can read their own usage (so the UI can surface remaining quota)
create policy "own usage read" on public.ai_usage
  for select using (auth.uid() = user_id);
-- No insert/update/delete policies for client. Only server functions
-- (using the service role key) modify this table.

-- Atomic increment + limit check. Returns { ok, count, limit }.
create or replace function public.increment_ai_usage(u uuid, f text, d date, l int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count int;
begin
  insert into public.ai_usage (user_id, day, function_name, count)
  values (u, d, f, 1)
  on conflict (user_id, day, function_name)
  do update set count = public.ai_usage.count + 1
  returning count into current_count;

  if current_count > l then
    -- Roll back the increment since we went over the limit
    update public.ai_usage
       set count = count - 1
     where user_id = u and day = d and function_name = f;
    return jsonb_build_object('ok', false, 'count', current_count - 1, 'limit', l);
  end if;

  return jsonb_build_object('ok', true, 'count', current_count, 'limit', l);
end;
$$;
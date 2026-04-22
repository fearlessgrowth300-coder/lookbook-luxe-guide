alter table public.styling_logs
  add column if not exists raw_response jsonb,
  add column if not exists validation_results jsonb,
  add column if not exists failure_reasons text[] default '{}'::text[];

create index if not exists styling_logs_failure_reasons_idx
  on public.styling_logs using gin (failure_reasons);
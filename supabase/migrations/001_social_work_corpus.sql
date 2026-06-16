create extension if not exists pgcrypto;

create table if not exists import_runs (
  id text primary key,
  started_at timestamptz not null,
  completed_at timestamptz,
  source text not null,
  dataset text not null,
  config text,
  split text,
  requested_limit integer,
  row_count integer not null default 0,
  card_count integer not null default 0,
  error text
);

create table if not exists raw_rows (
  id bigserial primary key,
  run_id text not null references import_runs(id) on delete cascade,
  source text not null,
  hf_row_idx integer,
  row_hash text not null,
  raw_json jsonb not null,
  license_note text not null,
  imported_at timestamptz not null default now()
);

create table if not exists evidence_cards (
  id text primary key,
  raw_row_id bigint references raw_rows(id) on delete set null,
  source text not null,
  client_group text not null,
  issue_tags jsonb not null default '[]'::jsonb,
  client_utterance text not null,
  worker_move text,
  affect text not null,
  risk_signals jsonb not null default '[]'::jsonb,
  resistance_type text,
  change_talk jsonb not null default '[]'::jsonb,
  disclosure_depth integer not null check (disclosure_depth between 1 and 4),
  quality text not null check (quality in ('approved', 'review', 'reject')),
  license_note text not null,
  provenance_note text,
  review_flags jsonb not null default '[]'::jsonb,
  search_vector tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(client_utterance, '') || ' ' ||
      coalesce(worker_move, '') || ' ' ||
      coalesce(issue_tags::text, '') || ' ' ||
      coalesce(risk_signals::text, '')
    )
  ) stored
);

create table if not exists curation_flags (
  id bigserial primary key,
  card_id text not null references evidence_cards(id) on delete cascade,
  flag text not null,
  reason text not null
);

create table if not exists simulator_sessions (
  session_id text primary key,
  case_id text not null,
  case_profile_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists simulator_events (
  id bigserial primary key,
  session_id text not null references simulator_sessions(session_id) on delete cascade,
  agent_trace_id text not null,
  event_type text not null,
  payload_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_raw_rows_run_id on raw_rows(run_id);
create index if not exists idx_evidence_source_quality on evidence_cards(source, quality);
create index if not exists idx_evidence_quality_usable on evidence_cards(source, client_group)
  where quality in ('approved', 'review');
create index if not exists idx_evidence_issue_tags_gin on evidence_cards using gin (issue_tags jsonb_path_ops);
create index if not exists idx_evidence_risk_signals_gin on evidence_cards using gin (risk_signals jsonb_path_ops);
create index if not exists idx_evidence_search_vector on evidence_cards using gin (search_vector);
create index if not exists idx_curation_card_id on curation_flags(card_id);
create index if not exists idx_simulator_events_session on simulator_events(session_id, id);

alter table import_runs enable row level security;
alter table raw_rows enable row level security;
alter table evidence_cards enable row level security;
alter table curation_flags enable row level security;
alter table simulator_sessions enable row level security;
alter table simulator_events enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'import_runs' and policyname = 'deny_import_runs_client_access') then
    create policy deny_import_runs_client_access on import_runs for all using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'raw_rows' and policyname = 'deny_raw_rows_client_access') then
    create policy deny_raw_rows_client_access on raw_rows for all using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'evidence_cards' and policyname = 'deny_evidence_cards_client_access') then
    create policy deny_evidence_cards_client_access on evidence_cards for all using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'curation_flags' and policyname = 'deny_curation_flags_client_access') then
    create policy deny_curation_flags_client_access on curation_flags for all using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'simulator_sessions' and policyname = 'deny_simulator_sessions_client_access') then
    create policy deny_simulator_sessions_client_access on simulator_sessions for all using (false) with check (false);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'simulator_events' and policyname = 'deny_simulator_events_client_access') then
    create policy deny_simulator_events_client_access on simulator_events for all using (false) with check (false);
  end if;
end $$;

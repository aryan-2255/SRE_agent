create table if not exists incidents (
  id text primary key,
  system text not null,
  service text not null,
  severity text,
  category text,
  status text not null default 'open',          -- open | mitigated | resolved | escalated | false_alarm
  stage text,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  jira_key text,
  pr_url text,
  total_cost_usd numeric not null default 0,
  fingerprint text,
  summary text,
  trigger jsonb
);

create table if not exists stages (
  id serial primary key,
  incident_id text not null references incidents(id),
  name text not null,
  status text not null,                          -- pending | running | waiting_approval | done | failed | skipped
  trueforge_session_id text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  cost_usd numeric not null default 0,
  attempt int not null default 1,
  output jsonb
);

create table if not exists approvals (
  id serial primary key,
  incident_id text not null references incidents(id),
  stage text not null,
  tool text not null,
  args jsonb,
  thread_id text,
  tool_call_id text,
  session_id text,
  status text not null default 'pending',        -- pending | approved | denied
  decided_by text,
  decided_via text,                              -- jira | dashboard | policy
  reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table if not exists events (
  id bigserial primary key,
  incident_id text,
  ts timestamptz not null default now(),
  stage text,
  kind text not null,
  text text,
  data jsonb
);

create index if not exists events_incident on events(incident_id, id);
create sequence if not exists incident_seq;

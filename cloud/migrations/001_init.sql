-- DS Bot cloud MVP: structured audit projection + hybrid search. Forward-only; the
-- down script is migrations/001_init.down.sql. DSH SessionEvents on /data stay authoritative.
create table schema_migrations (id text primary key, applied_at timestamptz not null default now());

create table runs (
  tenant_id text not null, project_id text not null, run_id text not null,
  task_id text, owner text not null, status text not null default 'open',
  claimed_outcome text, verified_outcome text not null default 'UNKNOWN',
  started_at timestamptz not null default now(), completed_at timestamptz,
  primary key (tenant_id, run_id)
);
create index runs_scope on runs (tenant_id, project_id, started_at desc);

-- Append-only: the unique source key makes a retry or a replay a no-op.
create table events (
  tenant_id text not null, project_id text not null, event_id text not null,
  run_id text not null, task_id text, agent_id text, session_id text, trace_id text,
  parent_event_id text, kind text not null, occurred_at timestamptz not null,
  claimed_outcome text, verified_outcome text not null default 'UNKNOWN',
  source_system text not null, source_id text not null, source_seq bigint not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  private_agent_id text,            -- set: only that agent's principal may read it
  body jsonb not null default '{}', -- metadata only; no prompts, reasoning or secrets
  primary key (tenant_id, event_id),
  unique (tenant_id, source_system, source_id, source_seq)
);
create index events_scope on events (tenant_id, project_id, occurred_at desc);
create index events_run on events (tenant_id, run_id, occurred_at);
create index events_agent on events (tenant_id, project_id, agent_id, kind);

create table authorizations (
  tenant_id text not null, project_id text not null, auth_id text not null,
  run_id text, actor text not null, action text not null, scope text not null,
  verdict text not null check (verdict in ('allow','deny')), reason text not null,
  approval_ref text,               -- a durable human approval; agent prose never fills this
  decided_at timestamptz not null default now(),
  primary key (tenant_id, auth_id)
);

create table artifacts (
  tenant_id text not null, project_id text not null, artifact_id text not null,
  run_id text, bucket text not null, object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), bytes bigint not null,
  media_type text not null, provenance jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (tenant_id, artifact_id), unique (tenant_id, bucket, object_key)
);

create table retrieval_chunks (
  tenant_id text not null, project_id text not null, chunk_id text not null,
  source_event_id text, source_ref text not null, content_hash text not null,
  private_agent_id text, text text not null,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  embedding real[], embedding_model text, embedding_dim int, index_version int not null default 1,
  created_at timestamptz not null default now(),
  primary key (tenant_id, chunk_id)
);
create index chunks_tsv on retrieval_chunks using gin (tsv);
create index chunks_scope on retrieval_chunks (tenant_id, project_id);

-- Authoritative events never wait for search: indexing is driven from here and retried.
create table ingestion_outbox (
  tenant_id text not null, event_id text not null, status text not null default 'pending',
  attempts int not null default 0, next_retry_at timestamptz not null default now(), last_error text,
  primary key (tenant_id, event_id)
);

create table retrieval_queries (
  tenant_id text not null, query_id text not null, project_id text, principal text not null,
  query_fp text not null, filters jsonb not null, mode text not null,
  candidates jsonb not null, retrieval_version int not null, latency_ms int not null,
  created_at timestamptz not null default now(), primary key (tenant_id, query_id)
);

create table relevance_labels (
  tenant_id text not null, query_id text not null, chunk_id text not null,
  grade int not null check (grade between 0 and 3), annotator text not null,
  split text not null check (split in ('train','validation','test')),
  primary key (tenant_id, query_id, chunk_id)
);

create table tasks_admitted (
  tenant_id text not null, project_id text not null, idempotency_key text not null,
  run_id text not null, scope text not null, principal text not null, job jsonb not null default '{}',
  dispatched boolean not null default false, route text,
  created_at timestamptz not null default now(), primary key (tenant_id, idempotency_key)
);

-- Replay protection for signed requests.
create table request_nonces (nonce text primary key, seen_at timestamptz not null default now());

-- Tenant isolation: every table is readable and writable only inside its tenant, and
-- private-agent rows only for that agent. The application role is not a superuser and
-- does not own the tables, so these policies cannot be bypassed by it.
do $$ declare t text; begin
  foreach t in array array['runs','events','authorizations','artifacts','retrieval_chunks','ingestion_outbox','retrieval_queries','relevance_labels','tasks_admitted'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
end $$;
create policy private_agent on events as restrictive for select
  using (private_agent_id is null or private_agent_id = current_setting('app.agent_id', true) or current_setting('app.role', true) = 'ingest');
create policy private_agent on retrieval_chunks as restrictive for select
  using (private_agent_id is null or private_agent_id = current_setting('app.agent_id', true) or current_setting('app.role', true) = 'ingest');

create or replace function cosine_sim(a real[], b real[]) returns double precision language sql immutable as $$
  select case when a is null or b is null or array_length(a,1) is distinct from array_length(b,1) then null
    else coalesce(sum(x*y) / nullif(sqrt(sum(x*x)) * sqrt(sum(y*y)), 0), 0) end
  from unnest(a, b) as t(x, y)
$$;

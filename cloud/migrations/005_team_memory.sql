-- Team memory: device-synced memories, observations, transcript turns, code provenance, the shared
-- skill/artifact library and the sync log. Additive: 001-004 are untouched. Original DS Bot design.
-- Every table carries tenant RLS; rows with private_agent_id are visible only to that agent or to a
-- principal whose app.bot_ids setting lists it (set per transaction by team-memory.mjs).

create table sync_devices (
  tenant_id text not null, device_id text not null, principal text not null, label text,
  revoked_at timestamptz, last_seen_at timestamptz, created_at timestamptz not null default now(),
  primary key (tenant_id, device_id)
);

create table memories (
  tenant_id text not null, memory_id text not null, project_id text, bot_id text,
  scope text not null default 'project', private_agent_id text,
  title text not null default '', body text not null, tags jsonb not null default '[]',
  version int not null default 1, updated_at_ms bigint not null, origin_device_id text not null,
  deleted_at timestamptz, created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(title, '') || ' ' || body)) stored,
  primary key (tenant_id, memory_id)
);
create index memories_tsv on memories using gin (tsv);
create index memories_scope on memories (tenant_id, project_id, updated_at_ms desc);

create table memory_revisions (
  tenant_id text not null, memory_id text not null, revision int not null,
  title text not null default '', body text not null, updated_at_ms bigint not null,
  origin_device_id text not null, origin_op_id text not null, applied boolean not null,
  private_agent_id text, created_at timestamptz not null default now(),
  primary key (tenant_id, memory_id, revision)
);

create table observations (
  tenant_id text not null, observation_id text not null, project_id text, session_id text, bot_id text,
  kind text not null default 'note', text text not null, occurred_at_ms bigint not null,
  private_agent_id text, origin_device_id text not null, deleted_at timestamptz,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  primary key (tenant_id, observation_id)
);
create index observations_tsv on observations using gin (tsv);
create index observations_session on observations (tenant_id, session_id);

create table transcript_turns (
  tenant_id text not null, turn_id text not null, project_id text, session_id text not null, bot_id text,
  seq int not null, role text not null, text text not null, occurred_at_ms bigint not null,
  private_agent_id text, origin_device_id text not null, deleted_at timestamptz,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  primary key (tenant_id, turn_id)
);
create index transcript_turns_tsv on transcript_turns using gin (tsv);
create index transcript_turns_session on transcript_turns (tenant_id, session_id, seq);

create table code_provenance (
  tenant_id text not null, provenance_id text not null, project_id text, session_id text, turn_id text, bot_id text,
  repo text, commit_sha text, pr_url text, path text, summary text not null default '',
  occurred_at_ms bigint not null, private_agent_id text, origin_device_id text not null, deleted_at timestamptz,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', coalesce(path, '') || ' ' || coalesce(repo, '') || ' ' || summary)) stored,
  primary key (tenant_id, provenance_id)
);
create index code_provenance_tsv on code_provenance using gin (tsv);
create index code_provenance_commit on code_provenance (tenant_id, commit_sha);
create index code_provenance_pr on code_provenance (tenant_id, pr_url);

create table shared_skills (
  tenant_id text not null, skill_id text not null, org_id text, name text not null, version int not null default 1,
  visibility text not null default 'tenant' check (visibility in ('tenant','org')),
  description text not null default '', body text not null, published_by text not null, deleted_at timestamptz,
  created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', name || ' ' || description || ' ' || body)) stored,
  primary key (tenant_id, skill_id), unique (tenant_id, name, version)
);
create index shared_skills_tsv on shared_skills using gin (tsv);

create table shared_artifacts (
  tenant_id text not null, artifact_id text not null, name text not null, description text not null default '',
  bucket text not null, object_key text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), bytes bigint not null, media_type text not null,
  registered_by text not null, deleted_at timestamptz, created_at timestamptz not null default now(),
  tsv tsvector generated always as (to_tsvector('simple', name || ' ' || description)) stored,
  primary key (tenant_id, artifact_id), unique (tenant_id, bucket, object_key)
);
create index shared_artifacts_tsv on shared_artifacts using gin (tsv);

-- server_seq is the pull cursor. A device op is applied at most once per (device, op).
create table memory_sync_log (
  tenant_id text not null, server_seq bigserial, origin_device_id text not null, origin_op_id text not null,
  entity text not null, entity_id text not null, op text not null, payload jsonb not null default '{}',
  private_agent_id text, created_at timestamptz not null default now(),
  primary key (tenant_id, server_seq), unique (tenant_id, origin_device_id, origin_op_id)
);

-- Embedding work waits here; a failed embedding never blocks a write.
create table memory_outbox (
  tenant_id text not null, outbox_id bigserial, entity text not null, entity_id text not null,
  status text not null default 'pending', attempts int not null default 0,
  next_retry_at timestamptz not null default now(), last_error text,
  primary key (tenant_id, outbox_id)
);

do $$ declare t text; begin
  foreach t in array array['sync_devices','memories','memory_revisions','observations','transcript_turns','code_provenance','shared_skills','shared_artifacts','memory_sync_log','memory_outbox'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) with check (tenant_id = current_setting(''app.tenant_id'', true))', t);
  end loop;
  foreach t in array array['memories','memory_revisions','observations','transcript_turns','code_provenance','memory_sync_log'] loop
    execute format($p$create policy private_agent on %I as restrictive for select using (private_agent_id is null
      or private_agent_id = current_setting('app.agent_id', true)
      or private_agent_id = any(string_to_array(coalesce(current_setting('app.bot_ids', true), ''), ',')))$p$, t);
  end loop;
end $$;

grant usage, select, update on all sequences in schema public to public;
alter default privileges in schema public grant usage, select, update on sequences to public;

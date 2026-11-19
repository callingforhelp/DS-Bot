-- DS Bot lineage: refusals and allowances imported from the lineage archive are projected into
-- authorizations with the Bot they were aimed at, the room, the event they came from and, for a
-- private Bot, the agent that may read them. Additive only.
alter table authorizations
  add column target text,
  add column room_id text,
  add column source_event_id text,
  add column private_agent_id text check (private_agent_id is null or private_agent_id <> '');
create index authorizations_scope_time on authorizations (tenant_id, project_id, decided_at desc);
create index authorizations_verdict on authorizations (tenant_id, verdict, decided_at desc);
create policy private_agent on authorizations as restrictive for select
  using (private_agent_id is null or private_agent_id = current_setting('app.agent_id', true) or current_setting('app.role', true) = 'ingest');

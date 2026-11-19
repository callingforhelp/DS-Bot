drop policy if exists private_agent on authorizations;
drop index if exists authorizations_verdict;
drop index if exists authorizations_scope_time;
alter table authorizations
  drop column if exists private_agent_id,
  drop column if exists source_event_id,
  drop column if exists room_id,
  drop column if exists target;
delete from schema_migrations where id = '003_lineage_authorizations.sql';

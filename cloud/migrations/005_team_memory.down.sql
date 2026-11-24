drop table if exists memory_outbox, memory_sync_log, shared_artifacts, shared_skills, code_provenance, transcript_turns, observations, memory_revisions, memories, sync_devices;
delete from schema_migrations where id = '005_team_memory.sql';

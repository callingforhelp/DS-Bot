-- Apply only where the pgvector extension exists (see 002). No fixed dimension: queries filter on
-- embedding_model first, so vectors from different embedding spaces never meet.
create extension if not exists vector;
do $$ declare t text; begin
  foreach t in array array['memories','observations','transcript_turns','code_provenance','shared_skills','shared_artifacts'] loop
    execute format('alter table %I add column if not exists embedding_v vector', t);
    execute format('alter table %I add column if not exists embedding_model text', t);
  end loop;
end $$;

drop function if exists cosine_sim(real[], real[]);
drop table if exists request_nonces, tasks_admitted, relevance_labels, retrieval_queries, ingestion_outbox, retrieval_chunks, artifacts, authorizations, events, runs, schema_migrations cascade;

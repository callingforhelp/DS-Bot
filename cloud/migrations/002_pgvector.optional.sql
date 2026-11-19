-- Apply only where the pgvector extension is available (verified locally with pgvector 0.8.7 on
-- Postgres 16; the managed target is still unverified). The column has no fixed dimension, so
-- providers with different dimensions can coexist; queries filter on embedding_model first, so
-- vectors from different embedding spaces never meet. Exact scan to start: add an HNSW index
-- per model (fixed dimension, partial index) only when measured recall and latency justify it.
create extension if not exists vector;
alter table retrieval_chunks add column embedding_v vector;

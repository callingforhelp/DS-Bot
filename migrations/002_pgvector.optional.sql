-- Apply only where the pgvector extension is available (the managed target). Same
-- columns, real index; vectors from different models never mix (embedding_model/dim).
create extension if not exists vector;
alter table retrieval_chunks add column embedding_v vector(1536);
-- Start with an exact scan; add HNSW only when measured recall/latency justify it:
-- create index chunks_hnsw on retrieval_chunks using hnsw (embedding_v vector_cosine_ops);

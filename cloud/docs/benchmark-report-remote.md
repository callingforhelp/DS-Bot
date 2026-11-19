# Remote benchmark A: mock embedder (RDS, pgvector)

Corpus: 25 synthetic events + 2 isolation probes (another tenant, a private agent). Queries: 11 (7 held-out test, 4 train). Vector engine: pgvector. Embedding model: mock-hash-256 (256-d). Index time for the whole corpus: 65568 ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
| lexical | 0.848 | 0.841 | 0.794 | 1440.1 | 0 |
| vector | 0.909 | 0.864 | 0.865 | 1456.9 | 0 |
| hybrid | 0.909 | 0.848 | 0.844 | 1658.0 | 0 |

Paraphrase-only queries (little word overlap with their answers: p1, p2, p3):

| mode | Recall@5 | MRR@10 |
|---|---|---|
| lexical | 0.667 | 0.667 |
| vector | 0.667 | 0.500 |
| hybrid | 0.667 | 0.667 |

Hashed word/trigram mock: it cannot match words it has never seen, so it is the baseline, not a semantic model.


# Remote benchmark B: text-embedding-3-small (RDS, pgvector)

Corpus: 25 synthetic events + 2 isolation probes (another tenant, a private agent). Queries: 11 (7 held-out test, 4 train). Vector engine: pgvector. Embedding model: text-embedding-3-small (1536-d). Index time for the whole corpus: 83875 ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
| lexical | 0.848 | 0.841 | 0.802 | 1434.3 | 0 |
| vector | 1.000 | 0.955 | 0.966 | 2186.3 | 0 |
| hybrid | 1.000 | 0.909 | 0.926 | 2172.9 | 0 |

Paraphrase-only queries (little word overlap with their answers: p1, p2, p3):

| mode | Recall@5 | MRR@10 |
|---|---|---|
| lexical | 0.667 | 0.667 |
| vector | 1.000 | 0.833 |
| hybrid | 1.000 | 0.833 |

Same corpus and queries as A. 11 queries on 25 documents: differences of a few hundredths are noise. Only synthetic text was sent to OpenAI.


# Retrieval benchmark (synthetic fixture, mock embedder)

Corpus: 25 synthetic events + 2 isolation probes (another tenant, a private agent). Queries: 8 (5 held-out test, 3 train). Index lag for the whole corpus: 37 ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
| lexical | 0.917 | 0.917 | 0.871 | 0.5 | 0 |
| vector | 1.000 | 1.000 | 0.983 | 1.1 | 0 |
| hybrid | 1.000 | 0.938 | 0.947 | 1.3 | 0 |

**What this does and does not show.** The vector branch uses a hashed word/trigram mock, not a semantic model, so vector and hybrid quality here are properties of the fusion code on a tiny corpus. Nothing here predicts text-embedding-3-small. The corpus is 25 documents and the query set is 8: differences of a few hundredths are noise. No reranker was trained. "Isolation leaks" counts results from the other tenant or the private agent and must be 0.

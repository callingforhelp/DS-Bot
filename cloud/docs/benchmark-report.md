# Retrieval benchmark (synthetic fixture, mock embedder)

Corpus: 25 synthetic events + 2 isolation probes (another tenant, a private agent). Queries: 8 (5 held-out test, 3 train). Index lag for the whole corpus: 35 ms.

| mode | Recall@5 | MRR@10 | nDCG@10 | mean latency ms | isolation leaks |
|---|---|---|---|---|---|
| lexical | 0.917 | 0.917 | 0.859 | 0.8 | 0 |
| vector | 1.000 | 1.000 | 0.968 | 1.1 | 0 |
| hybrid | 1.000 | 0.917 | 0.911 | 1.4 | 0 |

**What this does and does not show.** The vector branch uses a hashed word/trigram mock, not a semantic model, so vector and hybrid quality here are properties of the fusion code on a tiny corpus. Nothing here predicts text-embedding-3-small. The corpus is 25 documents and the query set is 8: differences of a few hundredths are noise. No reranker was trained. "Isolation leaks" counts results from the other tenant or the private agent and must be 0.

**Change on 19 Nov 2026.** Events now index more text (kind split into words, reason, action, Bot and room names) so DS Bot refusals can be found by their words. On this corpus recall is unchanged and isolation leaks stay 0, but ranking dipped (hybrid nDCG@10 0.947 to 0.911, lexical 0.871 to 0.859). On 8 queries that is within noise, but it was not tuned.

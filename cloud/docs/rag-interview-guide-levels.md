# RAG interview guide: easy → medium → hard

**Rehearsal edition — replaces the previous guide.**

Answers are written for speaking aloud. Start with the easy questions, use the medium questions to explain implementation, and use the hard questions to demonstrate diagnosis and judgment.

## What is actually backed by evidence?

| Label | Meaning in this guide |
|---|---|
| **Code-backed** | DS Bot source inspected at the expert-supplied `cloud/mvp` snapshot `bf431959bc32dc555b7dd1666793b174a5eb569d`. This establishes implementation, not deployment or a fresh passing test run. |
| **Reported implementation** | Dave’s conversation-search notes. Neither reviewer has a verified convsearch checkout or commit. |
| **Measured/report** | Historical DS Bot benchmark reports and Dave’s supplied disposable-Postgres replay account. The replay was not rerun for this guide. |
| **Proposed** | An improvement or experiment—not a shipped fix. |
| **Illustrative** | The promotion example and its possible LightRAG integration—not a measured deployment. |

Use “I implemented” only for work you actually performed. Do not use the previous promotion deck’s invented percentages, failure counts or escalation claims as interview evidence.

---

## Easy questions — explain the system clearly

### E1. What did you build, and what problem did it solve?

**Interviewer:** Explain your search work without starting with the technology.

**Candidate:** “We had two different information needs. Conversation search helped find what we had discussed across coding-agent sessions. Agent-trace search helped audit what happened: which action was requested, which bot was involved and why it was denied. Both return references to evidence. They are retrieval foundations for RAG, but I would not claim that either search result alone is a verified generated answer.”

**Actual connection:** Convsearch is described in Dave’s notes. DS Bot’s search returns ranked source references, event metadata and snippets, not an LLM-generated response. [S1]

**Remember:** “Finding evidence” and “answering from evidence” are separate capabilities.

### E2. Why combine keyword search and embeddings?

**Interviewer:** Why not just use vector search?

**Candidate:** “Identifiers and error strings often need lexical matching. Paraphrases may need semantic similarity. In the conversation-search implementation described in my notes, we search four lists: keyword and vector matches over both raw chunks and summary/tag keys. In DS Bot, we combine two rankings over indexed event text. I would test their contribution separately rather than assume vectors are always better.”

**Actual connection:** DS Bot uses Postgres `ts_rank_cd`, cosine-based vector retrieval and weighted reciprocal-rank fusion. Its benchmark used a hash-based mock, not semantic embeddings. [S1, S3]

**Trap:** This keyword ranker is not BM25, and keyword ranking is not an exact-ID guarantee.

### E3. What did you index?

**Interviewer:** Are the conversation index and trace index the same data?

**Candidate:** “No. The conversation system reportedly normalized Codex, Kimi and Pi transcripts, used roughly 3,000-character chunks, and indexed text plus generated summaries and tags in local Postgres. The audit system builds searchable text from structured events: kind, summary, reason, action, outcome and names when present. That makes it useful for finding a recorded refusal, but not for reconstructing a discussion that was never indexed.”

**Actual connection:** `textOf` constructs DS Bot’s event text; the indexer redacts and chunks it. Its chunk helper defaults to about 800 characters—not the conversation system’s 3,000. [S2, S4]

**Boundary:** Convsearch’s chunk size, four lists and Octen model history are reported implementation details, not freshly inspected code.

### E4. What did the conversation-search evaluation teach you?

**Interviewer:** Did retrieving the right session solve the user’s question?

**Candidate:** “Not necessarily. The supplied 12-question pilot found the right session in the top five for 10 questions, but short snippets fully answered none of the multi-fact questions. The reported OpenViking evaluation found all 12 sources and fully covered six answers, but surfaced two wrong claims before verification. The learning is to use summaries to locate evidence, then verify the answer against the original conversation, including later reversals.”

**Actual connection:** Those are Dave’s reported pilot results, not DS Bot metrics.

**Trap:** Do not claim the proposed surrounding-turn evidence view produced the OpenViking results, or assume a controlled before/after experiment without confirming its setup.

### E5. Where does LightRAG fit?

**Interviewer:** Did either implementation use LightRAG?

**Candidate:** “There is no evidence here that they did. LightRAG is an alternative retrieval architecture: it extracts entities and relationships from document chunks and retrieves graph context alongside source text. I would consider it for questions spanning related documents, not claim that our existing keyword/vector fusion already is LightRAG.”

**Actual connection:** LightRAG’s `hybrid` combines local entity-focused and global relationship-focused retrieval. Its `mix` mode also includes chunk-vector retrieval. DS Bot’s “hybrid” means keyword-plus-vector fusion. [L1]

---

## Medium questions — explain decisions and code

### M1. Walk me through one actual agent-trace search.

**Interviewer:** What happens when I ask, “Why was the message to Writer denied?”

**Candidate:** “The request carries its tenant and project scope, plus optional bot and time filters. The keyword path sanitizes the query into terms and uses OR matching with Postgres full-text ranking. The vector path embeds the redacted query and retrieves compatible stored embeddings. Both paths apply the same scope predicates. We fuse their ranks and return source references, short snippets and event metadata so the operator can inspect the evidence.”

**Actual connection:** Candidate depth is `max(limit × 5, 30)` per path; snippets use the first 240 characters. Event-time filtering uses `occurred_at`, not index time. The lineage tests include refusal reasons, dashed/undashed terms, a Chinese name and event-time filtering. Those tests were inspected, not rerun here. [S1, S5]

**Follow-up — what is missing?** “A snippet may omit the decisive fact. A source reference is a navigation aid, not proof that the answer is complete.”

### M2. Explain reciprocal-rank fusion and the one-vote rule.

**Interviewer:** How do you combine scores that are on different scales?

**Candidate:** “RRF uses positions rather than directly averaging keyword and cosine scores. In the DS Bot implementation, each chunk receives `1.5 / (60 + lexical rank)` plus `1 / (60 + vector rank)`, with ranks starting at one and a missing-list contribution of zero. Conversation search reportedly caps each session at one contribution per list, so many matching chunks from one long conversation cannot pile up votes.”

**Actual connection:** DS Bot’s `fuse` operates on chunk IDs; it does **not** implement the reported convsearch per-session cap. Ties are ordered by ID. [S1]

**Follow-up — why 1.5?** “It is the implemented configuration, not evidence of a 50% quality advantage. I would tune it on a held-out evaluation.”

### M3. Which conditions should be filters rather than ranking signals?

**Interviewer:** Why not put tenant, bot and time into the embedding text?

**Candidate:** “A highly similar result from the wrong tenant is still forbidden. Tenant and private-agent restrictions are enforced in SQL and row-level security; project, requested bot and event time also constrain retrieval. Ranking only orders eligible candidates. The application must derive trusted scope from authentication rather than let a user invent it.”

**Actual connection:** `withScope` uses transaction-local settings so tenant state does not persist on a pooled connection. A test checks that the SQL private-agent predicate still excludes rows even through a login that bypasses RLS. [S1, S5, S6]

**Boundary:** Action/verdict filters and dedicated exact-ID lookup are proposed extensions, not parameters implemented by the inspected `search` function.

### M4. What happens when embedding generation fails?

**Interviewer:** Does the whole search system go down?

**Candidate:** “The indexer writes lexical chunks and attempts embeddings. If the provider call fails, it marks the outbox entry for retry, leaving text searchable after the transaction commits. At query time, hybrid mode catches a vector-path failure and can return keyword results. It exposes whether vectors were used, so callers can distinguish degraded retrieval.”

**Actual connection:** Retry delay grows exponentially and is capped at one hour. `vectorUsed` is returned. [S1, S2]

**Trap:** Vector-only mode does not acquire a lexical fallback automatically; if its vector path fails, it can return no results. Availability is not proof of unchanged search quality.

### M5. How do you avoid turning a retry into a second audit event?

**Interviewer:** What if a laptop sends the same event again after losing its connection?

**Candidate:** “The cloud ingestion path uses a tenant-scoped source identity. A repeat with the same source hash is idempotent; a different hash under that identity reports a conflict instead of silently overwriting history. The shipper records acknowledged event IDs locally and stops on conflicts or errors. This lets us distinguish delivery retries from genuinely new evidence.”

**Actual connection:** The unique source tuple is tenant, source system, source ID and source sequence. The shipper keeps acknowledgement state in SQLite. [S7, S8]

**Trap:** Do not call this universal exactly-once delivery or claim a hash verifies the real-world truth of an event. It checks consistency with the supplied hash.

---

## Hard questions — diagnose regressions and defend limits

### H1. Explain the ranking regression step by step.

**Interviewer:** Why did adding useful-looking words make retrieval worse?

**Candidate:** “The patch added split event-kind words, such as ‘authorization denied,’ to indexed text. That can increase matching for both the relevant event and unrelated events with the same label. The fixture lacked the newly supported reason/action/name fields, so it mainly exercised event-kind expansion. Both keyword ranking and the mock vector ranking could change because both consumed the changed text.

“In the supplied PostgreSQL replay, the git-push denial stayed first in the vector list. But an unrelated bot-message denial rose from keyword rank two to one, while the actual git-push denial stayed at keyword rank three. With lexical rank weighted 1.5, the unrelated denial became first overall and the relevant event fell from fused rank two to three.”

**Actual connection:** The indexing patch and historical fixture are code-backed; the exact query-level swaps come from Dave’s supplied replay account. [B1, B2]

**Boundary:** A ranking regression is demonstrated. A wrong generated answer or lost customer is not measured.

### H2. Explain the metrics precisely.

**Interviewer:** How can recall stay at 1.000 while nDCG falls?

**Candidate:** “Recall at five measures how much labeled relevant evidence appears in the first five results. It does not care about order inside that set. nDCG discounts relevant results lower in the list. MRR considers only the first relevant result. Here recall stayed unchanged, while useful results moved lower.”

| Historical hybrid metric | Before | After |
|---|---:|---:|
| Recall@5 | 1.000 | 1.000 |
| nDCG@10, report rounded | 0.947 | 0.911 |
| MRR@10, report rounded | 0.938 | 0.917 |

**Candidate, if pressed:** “The supplied replay reproduced nDCG at 0.947229 and 0.911009. Four rounded contributions—0.01637, 0.01003, 0.00768 and 0.00214—sum to the 0.03622 loss. The first corresponds to the git-push question, about 45% of the loss. Its MRR change is `(1/2 − 1/3) / 8 = 0.020833`, explaining the aggregate MRR drop.”

**Actual connection:** The benchmark scores binary relevance, not a graded relevance rubric, although nDCG can support graded relevance generally. [B2, B3]

### H3. Is the benchmark convincing enough to change production?

**Interviewer:** What are the weaknesses in your own evidence?

**Candidate:** “It has 25 synthetic events, two isolation probes and eight queries, using deterministic hashed words and trigrams rather than real semantic embeddings. Its report aggregates all eight questions even though five are labeled test and three train. A reproducible fixture regression is worth investigating, but it is not evidence of production impact or a clean held-out tuning result.

“Reproduction also needs the exact historical fixture. Later benchmark code contains 11 queries while the saved report still describes eight. I would pin code, fixture, labels, index text and model before comparing results.”

**Actual connection:** The eight-query script is at the indexing-change commit. The later `benchlib` adds paraphrase questions. The OpenAI provider exists, but the mock results do not measure its quality. [B2, B4, S3]

**Follow-up — next experiment?** “Freeze a representative set, compare event-kind expansion off/on, record each retrieval path, then evaluate real embeddings with appropriate permission. Report held-out results separately.”

### H4. What did you actually fix, and what would you change next?

**Interviewer:** Did you ship a fix that recovered the score?

**Candidate:** “There is no measured post-fix recovery in the evidence available here. The replay resolved the diagnostic uncertainty. Next I would test distinguishing action from outcome so ‘git.push denied’ is not confused with ‘message_bot denied.’ I would compare action-aware matching against a weight-only change and check exact-ID and paraphrase regressions before selecting either.”

**Actual connection:** Search **already logs final returned candidate IDs and ranks** in `retrieval_queries`, along with a query fingerprint, filters, mode, retrieval version and latency. The proposed observability change is to add lexical/vector candidate ranks and enough versioned context for replay—not to claim there was no query logging. The published benchmark report itself contains aggregates only. [S1]

**Trap:** Do not turn a diagnosis, a candidate fix or an implemented logging field into a claim of measured production improvement.

### H5. Would LightRAG solve these problems?

**Interviewer:** Why not replace everything with graph RAG?

**Candidate:** “A graph helps when relevant evidence is connected across entities and documents, but it does not automatically fix outcome/action confusion, missing evidence or stale facts. DS Bot’s audit question often benefits first from structured filters and precise event references. Conversation search needs original turns and later corrections, not just richer summaries.

“For the illustrative promotion agent, LightRAG could retrieve links among a promotion, campaign, category and exclusion, plus source chunks. The application would still resolve the effective policy version, verify exact code identity and validate the cart with the coupon service. A stale graph edge is still stale evidence.”

**Proposed architecture:**

```text
Policy documents → LightRAG chunks + entity/relation extraction → indexes
Customer → authenticated application + applicable policy scope
         → LightRAG evidence retrieval
         → source/version verification + coupon-service validation
         → supported answer, explicit uncertainty or escalation
```

**Follow-up — when would you adopt it?** “When cross-document questions improve enough to justify extraction cost, update complexity and latency against a simpler scoped keyword/vector baseline. LightRAG’s `hybrid` is local-plus-global graph retrieval; it is not DS Bot’s lexical/vector fusion.” [L1]

---

## One opening answer to rehearse — about 90 seconds

**Interviewer:** Tell me about your RAG experience and a failure you learned from.

**Candidate:**

“My strongest concrete work is on retrieval foundations: finding prior conversations and auditing agent events. Conversation search, as described in our implementation notes, indexes transcript chunks and summary/tag keys, combines four ranked lists and caps each session at one vote per list. Its pilot taught us that finding the right session is not the same as returning enough evidence to answer a question.

“The agent-trace implementation is different: it indexes redacted structured event text, applies tenant, project, private-agent, bot and time constraints, and combines keyword and vector ranks in Postgres.

“One regression came after enriching indexed event types with separate words. In an eight-query synthetic benchmark, recall at five stayed perfect, but nDCG at ten fell from 0.947 to 0.911. The supplied replay showed an unrelated denial being promoted by the keyword path and weighted fusion, pushing the relevant git-push denial lower.

“That established a ranking failure, not a production-answer failure. The next proposed fix is action-aware matching, tested against exact-ID and paraphrase cases. I would extend existing query logs with per-path ranks and repeat the evaluation with real embeddings.

“The main lesson is to identify which stage failed—candidate retrieval, ranking, evidence coverage or generation—before changing models or adding a graph.”

## Final rehearsal checks

- Explain the user’s question before naming a model.
- Distinguish a session hit, an event hit and a supported answer.
- Say which claims are inspected code, reported results or proposals.
- Name the mock embedding and eight-query limitation without being prompted.
- Never claim DS Bot uses LightRAG or the four-list session cap.
- Never describe fictional promotion results as a shipped success.

## Evidence map

**Conversation search:** Dave’s pasted implementation and pilot notes. No source repository/commit was available to either reviewer. These notes report Octen VL originally and a text-embedding model as the later default; they do not establish settings from an inspected checkout.

**Latest expert-supplied agent-trace snapshot:** Source inspected at the immutable commit below. Tests were read, not executed for this document.

- **S1 — search:** [query filters, rank fusion, source results and query logs](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/search.mjs)
- **S2 — indexer:** [text enrichment, source references and embedding retries](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/indexer.mjs)
- **S3 — embeddings:** [mock hash vectors and the separately configured OpenAI provider](https://github.com/callingforhelp/DS-Bot/blob/877081b0/cloud/src/embed.mjs)
- **S4 — redaction/chunking:** [event-text processing](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/redact.mjs)
- **S5 — lineage search tests:** [event-time, refusal terms, names and SQL private-row filtering](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/test/search-lineage.test.mjs)
- **S6 — database scope:** [transaction-local settings](https://github.com/callingforhelp/DS-Bot/blob/877081b0/cloud/src/db.mjs) and [RLS policies](https://github.com/callingforhelp/DS-Bot/blob/877081b0/cloud/migrations/001_init.sql)
- **S7 — ingestion:** [source identity, duplicate handling and conflicts](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/ingest.mjs)
- **S8 — shipping:** [local acknowledgement state and retry stopping behavior](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/lineage/ship.mjs)
- **Reader boundary:** [Mac lineage readers](https://github.com/callingforhelp/DS-Bot/blob/bf431959bc32dc555b7dd1666793b174a5eb569d/cloud/src/lineage/readers.mjs) are audit infrastructure; they are not the missing convsearch implementation.

**Historical measurement, separate from the newer snapshot:**

- **B1:** [indexing change](https://github.com/callingforhelp/DS-Bot/commit/1ddbf0f2)
- **B2:** [eight-query benchmark script](https://github.com/callingforhelp/DS-Bot/blob/1ddbf0f2/cloud/scripts/bench.mjs)
- **B3:** [before report](https://github.com/callingforhelp/DS-Bot/blob/a641018e/cloud/docs/benchmark-report.md) and [after report](https://github.com/callingforhelp/DS-Bot/blob/877081b0/cloud/docs/benchmark-report.md)
- **B4:** [later eleven-query benchmark code](https://github.com/callingforhelp/DS-Bot/blob/877081b0/cloud/scripts/benchlib.mjs)
- Exact six-decimal reproduction and rank-swap attribution: Dave’s supplied PostgreSQL replay account, not independently rerun here.

**L1:** [LightRAG documentation](https://github.com/HKUDS/LightRAG), checked against the session checkout for indexing and retrieval-mode descriptions. The integration remains a design proposal.

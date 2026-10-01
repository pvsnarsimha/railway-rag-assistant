# Evaluation: what is measured, and how far to trust it

Run: `python backend/evaluation/run_eval.py` -> `docs/EVAL_REPORT.md` + `docs/eval_results.json`.
CI enforces `backend/evaluation/thresholds.json` (a ratchet: set just under the current numbers).

## What it measures
1. **Intent routing** (`query_router.classify`): 67 labelled queries across 10 intents: accuracy, per-intent
   precision/recall/F1, and entity extraction (PNR, train number, radius).
2. **RAG retrieval**: 51 questions each labelled with the KB entry (or entries) that answers it: Hit@1/3/5, MRR.
3. **Latency**: p50/p95/p99 for `classify`, retrieval, `/healthz`, and a full offline `/api/chat` FAQ round-trip
   (in-process TestClient, external providers disabled).

## What it does not measure (do not claim these from this report)
- **Real-user accuracy.** The sets are small and written by the developers, so the numbers are regression baselines.
  Replace/extend them with anonymised real queries from the chat log for field accuracy.
- **LLM answer quality** (faithfulness, hallucination). Needs API keys, cost, and human or LLM-judge grading.
- **Delay-prediction accuracy.** The shipped model trains on a synthetic heuristic dataset, so offline error against it
  is meaningless. The real number comes from `delay_accuracy_store` (predicted-vs-actual per station), reported in
  `/api/health -> delay_prediction_training`; compute MAE from it once real rows accumulate.
- **Production latency.** Excludes network, cold starts (free tier ~30-60 s) and upstream providers. Use `/api/metrics`
  on the live service for real p95s.
- Retrieval numbers are for the **TF-IDF/SVD fallback** (what CI and the lean Render build use). Production with
  `sentence-transformers` installed may differ; the report states which backend ran.

## Adding cases
Append `[query, expected_intent, {entity: value}]` to `intent_cases.json` or `[question, [acceptable_kb_ids]]` to
`retrieval_cases.json`. Fix the code rather than editing a case to pass; raise thresholds when numbers improve.

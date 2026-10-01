# Evaluation: what is measured, and how far to trust it

Run: `python backend/evaluation/run_eval.py` -> `docs/EVAL_REPORT.md` + `docs/eval_results.json`.
CI enforces `backend/evaluation/thresholds.json` (a ratchet: set just under the current numbers).

## What it measures
1. **Intent routing** (`query_router.classify`), five query sets across 10 intents. Four are *regression sets*
   (the router was developed against them, so 100% there only proves nothing broke). One, `intent_cases_blind.json`,
   is **frozen and never tuned on**; it is the only honest estimate of accuracy on new wording
   (**76.9%**, up from 56.4% before the routing fixes). When you fix a blind miss, write a fresh blind set, don't
   reuse that one.
2. **RAG retrieval**: 51 questions each labelled with the KB entry (or entries) that answers it: Hit@1/3/5, MRR.
3. **Latency**: p50/p95/p99 for `classify`, retrieval, `/healthz`, and a full offline `/api/chat` FAQ round-trip
   (in-process TestClient, external providers disabled).

4. **Generated answers** (`python backend/evaluation/answer_eval.py`, report in `docs/ANSWER_EVAL_REPORT.md`):
   30 factual questions whose expected facts were verified against the knowledge base, 6 out-of-scope questions,
   4 live-data-unavailable questions. Reports fact recall, share of answers with every fact, whether the gold KB
   entry was retrieved, **required facts still present in the text handed to the LLM after compression**,
   answers stating a number found in neither the question nor the sources (a hallucination signal),
   off-topic decline rate, honesty when live data is missing, and latency.
   Modes: default = offline extractive answers (used by CI); `--llm` = in-process with your API keys;
   `--url https://<app>` = the deployed service with the real LLM; add `--judge` for an LLM-as-judge faithfulness
   score (1-5) using Gemini or Claude.

## What it does not measure (do not claim these from this report)
- **Real-user accuracy.** The sets are small and written by the developers, so the numbers are regression baselines.
  Replace/extend them with anonymised real queries from the chat log for field accuracy.
- **LLM answer quality is not yet measured.** The committed numbers are for the offline path. Run
  `python backend/evaluation/answer_eval.py --url https://<your-app> --judge` against the deployed app to get the real
  LLM numbers (it costs a few dozen LLM calls). String matching detects presence of facts and invented numbers, not
  wording quality or subtle contradictions; the judge score covers faithfulness but is itself an LLM opinion.
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

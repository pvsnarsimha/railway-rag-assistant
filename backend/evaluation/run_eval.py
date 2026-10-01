"""
Offline evaluation: accuracy + latency numbers for the parts of the system
that can be measured without API keys or network.

    python evaluation/run_eval.py                 # print + write reports
    python evaluation/run_eval.py --check         # also enforce thresholds.json (CI gate)

Measures
  1. Intent routing   - accuracy, per-intent precision/recall/F1, entity extraction accuracy
  2. RAG retrieval    - Hit@1/3/5 and MRR against labelled question -> KB-entry pairs
  3. Latency          - p50/p95/p99 for classify(), retrieve(), and full HTTP round-trips
                        (in-process TestClient, external providers off)

Read the caveat in docs/EVALUATION.md before quoting these anywhere: the test
sets are small, hand-written, and measure regressions against a fixed
baseline, not accuracy on real user traffic.
"""
import argparse
import json
import os
import platform
import statistics
import sys
import time
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)
os.chdir(BACKEND)
for k in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "RAPIDAPI_KEY", "TAVILY_API_KEY"):
    os.environ.pop(k, None)   # measure the offline paths, never bill or hit a provider


def pct(vals, p):
    vals = sorted(vals)
    k = (len(vals) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)


def lat_stats(ms):
    return {"n": len(ms), "p50_ms": round(pct(ms, 50), 2), "p95_ms": round(pct(ms, 95), 2),
            "p99_ms": round(pct(ms, 99), 2), "mean_ms": round(statistics.mean(ms), 2)}


def timed(fn, reps):
    out = []
    for _ in range(reps):
        t = time.perf_counter()
        fn()
        out.append((time.perf_counter() - t) * 1000)
    return out


def eval_intents():
    import query_router
    cases = json.load(open(os.path.join(HERE, "intent_cases.json"), encoding="utf-8"))
    tp, fp, fn = Counter(), Counter(), Counter()
    confusion = defaultdict(Counter)
    misses, ent_total, ent_ok, ent_fail = [], 0, 0, []
    for text, want, want_ent in cases:
        got = query_router.classify(text)
        gi = got["intent"].value
        confusion[want][gi] += 1
        if gi == want:
            tp[want] += 1
        else:
            fn[want] += 1
            fp[gi] += 1
            misses.append({"text": text, "expected": want, "got": gi})
        for key, val in want_ent.items():
            ent_total += 1
            if gi == want and got["entities"].get(key) == val:
                ent_ok += 1
            else:
                ent_fail.append({"text": text, "field": key, "expected": val, "got": got["entities"].get(key)})
    per = {}
    for intent in sorted(set(c[1] for c in cases)):
        p = tp[intent] / (tp[intent] + fp[intent]) if tp[intent] + fp[intent] else 0.0
        r = tp[intent] / (tp[intent] + fn[intent]) if tp[intent] + fn[intent] else 0.0
        per[intent] = {"support": tp[intent] + fn[intent], "precision": round(p, 3), "recall": round(r, 3),
                       "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0}
    correct = sum(tp.values())
    return {
        "n": len(cases), "accuracy": round(correct / len(cases), 4),
        "macro_f1": round(statistics.mean(v["f1"] for v in per.values()), 4),
        "entity_accuracy": round(ent_ok / ent_total, 4) if ent_total else None,
        "entity_checks": ent_total, "per_intent": per, "misses": misses, "entity_failures": ent_fail,
    }


def eval_retrieval():
    from rag_engine import get_engine
    eng = get_engine()
    cases = json.load(open(os.path.join(HERE, "retrieval_cases.json"), encoding="utf-8"))
    eng.retrieve("warm up", top_k=5)
    hits = {1: 0, 3: 0, 5: 0}
    rr, misses, lat = 0.0, [], []
    for q, gold in cases:
        t = time.perf_counter()
        res = eng.retrieve(q, top_k=5)
        lat.append((time.perf_counter() - t) * 1000)
        ids = [c.id for c in res.chunks]
        rank = next((i + 1 for i, x in enumerate(ids) if x in gold), None)
        if rank:
            rr += 1 / rank
            for k in hits:
                hits[k] += rank <= k
        else:
            misses.append({"question": q, "expected_any_of": gold, "got": ids})
    n = len(cases)
    return {"n": n, "engine": eng.hybrid.semantic_engine_name, "kb_entries": len(eng.docs),
            "hit_at_1": round(hits[1] / n, 4), "hit_at_3": round(hits[3] / n, 4),
            "hit_at_5": round(hits[5] / n, 4), "mrr": round(rr / n, 4),
            "latency": lat_stats(lat), "misses": misses}


def eval_latency(retrieval_questions, intent_texts):
    import query_router
    from rag_engine import get_engine
    eng = get_engine()
    out = {}
    out["classify"] = lat_stats(timed(lambda: [query_router.classify(t) for t in intent_texts], 20))
    out["classify"] = {k: (round(v / len(intent_texts), 3) if k.endswith("_ms") else v * len(intent_texts))
                       for k, v in out["classify"].items()}   # per-call, not per-batch

    import itertools
    qs = itertools.cycle(retrieval_questions)
    out["rag_retrieve_top5"] = lat_stats(timed(lambda: eng.retrieve(next(qs), top_k=5), 100))

    from fastapi.testclient import TestClient
    import app as app_module
    import observability
    import railway_agent
    app_module.web_search.search_web = lambda *a, **k: []
    railway_agent.is_available = lambda: False
    client = TestClient(app_module.app)
    client.get("/healthz")
    observability.reset()
    out["http_healthz"] = lat_stats(timed(lambda: client.get("/healthz"), 200))
    faq = itertools.cycle(["how does tatkal booking work", "refund rules for cancelled tickets",
                           "what is RAC", "luggage limit in AC 2 tier"])
    out["http_chat_faq_offline"] = lat_stats(timed(
        lambda: client.post("/api/chat", json={"message": next(faq), "agent": False}), 60))
    return out


def render_md(rep):
    i, r, L = rep["intent_routing"], rep["retrieval"], rep["latency"]
    lines = [f"# Evaluation report", "",
             f"- version `{rep['version']}`, commit `{rep['commit'][:7]}`, generated {rep['generated_utc']}",
             f"- python {rep['python']} on {rep['machine']}; retrieval backend: **{r['engine']}**", "",
             "## 1. Intent routing", "",
             f"{i['n']} labelled queries. **Accuracy {i['accuracy']:.1%}**, macro-F1 {i['macro_f1']:.3f}, "
             f"entity extraction {i['entity_accuracy']:.1%} ({i['entity_checks']} fields).", "",
             "| intent | support | precision | recall | F1 |", "|---|---:|---:|---:|---:|"]
    for k, v in i["per_intent"].items():
        lines.append(f"| {k} | {v['support']} | {v['precision']:.2f} | {v['recall']:.2f} | {v['f1']:.2f} |")
    lines += ["", f"### Routing misses ({len(i['misses'])})", "", "| query | expected | got |", "|---|---|---|"]
    lines += [f"| {m['text']} | {m['expected']} | {m['got']} |" for m in i["misses"]]
    if i["entity_failures"]:
        lines += ["", f"### Entity extraction misses ({len(i['entity_failures'])})", ""]
        lines += [f"- `{m['text']}` {m['field']}: expected {m['expected']!r}, got {m['got']!r}" for m in i["entity_failures"]]
    lines += ["", "## 2. RAG retrieval", "",
              f"{r['n']} labelled questions over {r['kb_entries']} KB entries. "
              f"**Hit@1 {r['hit_at_1']:.1%} · Hit@3 {r['hit_at_3']:.1%} · Hit@5 {r['hit_at_5']:.1%} · MRR {r['mrr']:.3f}**", "",
              f"### Retrieval misses ({len(r['misses'])})", ""]
    lines += [f"- {m['question']!r} wanted one of {m['expected_any_of']}, got {m['got'][:3]}" for m in r["misses"]]
    lines += ["", "## 3. Latency (in-process, providers disabled)", "",
              "| operation | n | p50 ms | p95 ms | p99 ms | mean ms |", "|---|---:|---:|---:|---:|---:|"]
    for k, v in L.items():
        lines.append(f"| {k} | {v['n']} | {v['p50_ms']} | {v['p95_ms']} | {v['p99_ms']} | {v['mean_ms']} |")
    lines += ["", "Latency excludes network, cold start and any external provider "
              "(RailKit/RailRadar/LLM) time. See docs/EVALUATION.md.", ""]
    return "\n".join(lines)


def check(rep, th):
    fails = []
    def need(name, val, minimum):
        if val < minimum:
            fails.append(f"{name} {val} < required {minimum}")
    def cap(name, val, maximum):
        if val > maximum:
            fails.append(f"{name} {val} > allowed {maximum}")
    need("intent accuracy", rep["intent_routing"]["accuracy"], th["intent_accuracy_min"])
    need("entity accuracy", rep["intent_routing"]["entity_accuracy"], th["entity_accuracy_min"])
    need("retrieval hit@3", rep["retrieval"]["hit_at_3"], th["retrieval_hit_at_3_min"])
    need("retrieval mrr", rep["retrieval"]["mrr"], th["retrieval_mrr_min"])
    cap("classify p95 ms", rep["latency"]["classify"]["p95_ms"], th["classify_p95_ms_max"])
    cap("retrieve p95 ms", rep["latency"]["rag_retrieve_top5"]["p95_ms"], th["retrieve_p95_ms_max"])
    cap("healthz p95 ms", rep["latency"]["http_healthz"]["p95_ms"], th["healthz_p95_ms_max"])
    cap("chat(faq) p95 ms", rep["latency"]["http_chat_faq_offline"]["p95_ms"], th["chat_faq_p95_ms_max"])
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=os.path.join(ROOT, "docs"))
    args = ap.parse_args()
    import version
    intents = eval_intents()
    retrieval = eval_retrieval()
    cases_i = [c[0] for c in json.load(open(os.path.join(HERE, "intent_cases.json"), encoding="utf-8"))]
    cases_r = [c[0] for c in json.load(open(os.path.join(HERE, "retrieval_cases.json"), encoding="utf-8"))]
    rep = {"version": version.VERSION, "commit": version.COMMIT,
           "generated_utc": time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime()),
           "python": platform.python_version(), "machine": f"{platform.system()} {platform.machine()}",
           "intent_routing": intents, "retrieval": retrieval,
           "latency": eval_latency(cases_r, cases_i)}
    os.makedirs(args.out, exist_ok=True)
    json.dump(rep, open(os.path.join(args.out, "eval_results.json"), "w"), indent=1)
    md = render_md(rep)
    open(os.path.join(args.out, "EVAL_REPORT.md"), "w", encoding="utf-8").write(md)
    print(md)
    if args.check:
        th = json.load(open(os.path.join(HERE, "thresholds.json")))
        fails = check(rep, th)
        if fails:
            print("\nEVALUATION GATE FAILED:\n  " + "\n  ".join(fails))
            sys.exit(1)
        print("\nEvaluation gate passed.")


if __name__ == "__main__":
    main()

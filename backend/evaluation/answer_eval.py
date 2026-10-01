"""
Evaluation of the *generated answers* (what the user actually reads), not just retrieval.

    python evaluation/answer_eval.py                      # offline: no LLM, extractive fallback answers
    python evaluation/answer_eval.py --check              # also enforce answer_thresholds.json (CI)
    python evaluation/answer_eval.py --llm                # in-process, uses GEMINI_API_KEY / ANTHROPIC_API_KEY from env
    python evaluation/answer_eval.py --url https://<app>.onrender.com   # the real deployed service (real LLM)
    python evaluation/answer_eval.py --url ... --judge    # + LLM-as-judge faithfulness score (needs a key)

Metrics (30 factual, 6 out-of-scope, 4 no-live-data questions; see answer_cases.json)
  fact_recall        mean fraction of required facts present in the answer
  full_fact_rate     share of answers containing every required fact
  source_hit         share where the gold knowledge-base entry was retrieved (links to retrieval eval)
  unsupported_number share of answers stating a number found in neither the question nor the
                     retrieved sources  (a cheap, deterministic hallucination signal)
  decline_rate       share of out-of-scope questions the assistant declined instead of answering
  honest_no_data     share of live-data questions (provider unavailable) answered without
                     inventing live facts and with an honest "couldn't get it" message
  latency            p50 / p95

Honest limits: string matching detects the *presence* of facts and the *absence* of invented numbers,
not wording quality or subtle contradictions. Use --judge (LLM-as-judge) for faithfulness grading.
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
ROOT = os.path.dirname(BACKEND)
sys.path.insert(0, BACKEND)

_NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").lower().replace("’", "'"))


def numbers_in(text: str) -> set:
    return {n.replace(",", "").rstrip(".") for n in _NUM_RE.findall(text or "")}


# ---------------------------------------------------------------- scoring (pure functions)
def score_factual(case: dict, answer: str, sources: list, kb_text: dict) -> dict:
    a = norm(answer)
    groups = case["required"]
    hit = [any(norm(alt) in a for alt in grp) for grp in groups]
    context = " ".join(kb_text.get(s, "") for s in sources)
    allowed = numbers_in(case["q"]) | numbers_in(context)
    # Ignore list numbering ("1.", "2.") and trivially small numbers.
    unsupported = sorted(n for n in numbers_in(answer) - allowed if len(n) > 1 or int(n) > 9)
    return {
        "fact_recall": sum(hit) / len(hit),
        "full_facts": all(hit),
        "missing": [groups[i][0] for i, h in enumerate(hit) if not h],
        "source_hit": any(g in sources for g in case["gold"]),
        "unsupported_numbers": unsupported,
    }


def score_context(case: dict, context_text: str) -> dict:
    """What the LLM actually sees: are the required facts still present after retrieval + compression?"""
    c = norm(context_text)
    hit = [any(norm(alt) in c for alt in grp) for grp in case["required"]]
    return {"context_recall": sum(hit) / len(hit), "context_full": all(hit)}


def score_abstain(answer: str, decline_markers: list) -> dict:
    a = norm(answer)
    return {"declined": any(m in a for m in decline_markers)}


def score_no_live(answer: str, honesty_markers: list, live_claims: list) -> dict:
    a = norm(answer)
    invented = [c for c in live_claims if c in a]
    honest = any(m in a for m in honesty_markers)
    return {"honest": honest and not invented, "invented": invented}


def pct(vals, p):
    vals = sorted(vals)
    if not vals:
        return 0.0
    k = (len(vals) - 1) * p / 100
    lo = int(k)
    hi = min(lo + 1, len(vals) - 1)
    return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)


def summarize(factual, abstain, nolive, latencies, mode) -> dict:
    n = len(factual)
    out = {
        "mode": mode,
        "factual": {
            "n": n,
            "fact_recall": round(sum(r["fact_recall"] for r in factual) / n, 4),
            "full_fact_rate": round(sum(r["full_facts"] for r in factual) / n, 4),
            "source_hit": round(sum(r["source_hit"] for r in factual) / n, 4),
            "unsupported_number_rate": round(sum(bool(r["unsupported_numbers"]) for r in factual) / n, 4),
            **({"context_fact_recall": round(sum(r["context_recall"] for r in factual) / n, 4),
                "context_full_rate": round(sum(r["context_full"] for r in factual) / n, 4)}
               if "context_recall" in factual[0] else {}),
        },
        "out_of_scope": {"n": len(abstain), "decline_rate": round(sum(r["declined"] for r in abstain) / len(abstain), 4)},
        "no_live_data": {"n": len(nolive), "honest_rate": round(sum(r["honest"] for r in nolive) / len(nolive), 4)},
        "latency": {"n": len(latencies), "p50_ms": round(pct(latencies, 50), 1), "p95_ms": round(pct(latencies, 95), 1)},
    }
    judged = [r["judge"]["faithfulness"] for r in factual if r.get("judge")]
    if judged:
        out["judge"] = {"n": len(judged), "mean_faithfulness_1to5": round(sum(judged) / len(judged), 2),
                        "faithful_rate_ge4": round(sum(j >= 4 for j in judged) / len(judged), 4)}
    return out


# ---------------------------------------------------------------- LLM-as-judge (optional)
JUDGE_PROMPT = """You are grading an answer from a railway assistant against its source excerpts.
Question: {q}
Source excerpts:
{ctx}
Answer to grade:
{a}

Score FAITHFULNESS 1-5: 5 = every claim is supported by the excerpts; 3 = mostly supported, some
unsupported detail; 1 = contradicts or invents facts. Reply with JSON only: {{"faithfulness": <1-5>, "reason": "<short>"}}"""


def parse_judge(text: str):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        d = json.loads(m.group(0))
        f = int(d["faithfulness"])
        return {"faithfulness": max(1, min(5, f)), "reason": str(d.get("reason", ""))[:200]}
    except (ValueError, KeyError, TypeError):
        return None


def default_judge_call(prompt: str) -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        from google import genai
        r = genai.Client(api_key=key).models.generate_content(
            model=os.environ.get("JUDGE_MODEL", os.environ.get("GEMINI_MODEL", "gemini-flash-latest")), contents=prompt)
        return r.text or ""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        import anthropic
        r = anthropic.Anthropic(api_key=key).messages.create(
            model=os.environ.get("JUDGE_MODEL", os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001")),
            max_tokens=300, messages=[{"role": "user", "content": prompt}])
        return r.content[0].text
    raise RuntimeError("--judge needs GEMINI_API_KEY or ANTHROPIC_API_KEY")


def judge(case, answer, sources, kb_text, call=default_judge_call):
    ctx = "\n".join(f"[{s}] {kb_text.get(s, '')[:900]}" for s in sources[:4])
    return parse_judge(call(JUDGE_PROMPT.format(q=case["q"], ctx=ctx, a=answer[:2500])))


# ---------------------------------------------------------------- chat runners
def make_runner(args):
    if args.url:
        import requests
        base = args.url.rstrip("/")

        def run(q):
            t = time.perf_counter()
            r = requests.post(f"{base}/api/chat", json={"message": q, "agent": False}, timeout=90)
            ms = (time.perf_counter() - t) * 1000
            d = r.json()
            return d.get("answer", ""), d.get("sources", []) or [], ms
        return run, "remote:" + base

    if not args.llm:
        for k in ("GEMINI_API_KEY", "ANTHROPIC_API_KEY", "RAPIDAPI_KEY", "TAVILY_API_KEY"):
            os.environ.pop(k, None)
    os.chdir(BACKEND)
    from fastapi.testclient import TestClient
    import app as app_module
    import railway_agent
    if not args.llm:
        app_module.web_search.search_web = lambda *a, **k: []
        railway_agent.is_available = lambda: False
    client = TestClient(app_module.app)

    def run(q):
        t = time.perf_counter()
        d = client.post("/api/chat", json={"message": q, "agent": False}).json()
        return d.get("answer", ""), d.get("sources", []) or [], (time.perf_counter() - t) * 1000

    def context(q):
        res = app_module.get_engine().retrieve(q, top_k=3)
        return " ".join(c.compressed_text for c in res.chunks)
    run.context = context
    return run, ("in-process with LLM keys from env" if args.llm else "offline (no LLM, extractive fallback)")


def render_md(rep, details) -> str:
    f, o, n, L = rep["factual"], rep["out_of_scope"], rep["no_live_data"], rep["latency"]
    lines = ["# Answer-quality evaluation", "",
             f"- mode: **{rep['mode']}**", f"- generated {time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime())}", "",
             "| metric | result |", "|---|---:|",
             f"| fact recall (required facts present) | {f['fact_recall']:.1%} |",
             f"| answers with every required fact | {f['full_fact_rate']:.1%} |",
             f"| gold KB entry retrieved | {f['source_hit']:.1%} |",
             *([f"| required facts still present in the text handed to the LLM (after compression) | {f['context_fact_recall']:.1%} |"]
               if "context_fact_recall" in f else []),
             f"| answers stating an unsupported number | {f['unsupported_number_rate']:.1%} |",
             f"| out-of-scope questions declined | {o['decline_rate']:.1%} ({o['n']} questions) |",
             f"| live-data-unavailable answered honestly | {n['honest_rate']:.1%} ({n['n']} questions) |",
             f"| latency p50 / p95 | {L['p50_ms']} / {L['p95_ms']} ms |"]
    if "judge" in rep:
        j = rep["judge"]
        lines.append(f"| LLM-judge faithfulness (1-5) | {j['mean_faithfulness_1to5']} (>=4 on {j['faithful_rate_ge4']:.0%}) |")
    lines += ["", f"{f['n']} factual questions. Facts are matched as strings, so this measures presence of correct facts "
              "and absence of invented numbers, not wording quality. See docs/EVALUATION.md.", ""]
    miss = [d for d in details["factual"] if not d["full_facts"]]
    lines += [f"## Factual answers missing a required fact ({len(miss)})", ""]
    lines += [f"- **{d['id']}**: {d['q']} -> missing {d['missing']}" for d in miss]
    uns = [d for d in details["factual"] if d["unsupported_numbers"]]
    lines += ["", f"## Answers with numbers not in the question or sources ({len(uns)})", ""]
    lines += [f"- **{d['id']}**: {d['unsupported_numbers']}" for d in uns]
    bad = [d for d in details["out_of_scope"] if not d["declined"]]
    lines += ["", f"## Out-of-scope questions NOT declined ({len(bad)})", ""]
    lines += [f"- {d['q']} -> answered: \"{d['answer'][:140].strip()}...\"" for d in bad]
    bad = [d for d in details["no_live_data"] if not d["honest"]]
    lines += ["", f"## Live-data questions not handled honestly ({len(bad)})", ""]
    lines += [f"- {d['q']} (invented: {d['invented']}) -> \"{d['answer'][:140].strip()}...\"" for d in bad]
    return "\n".join(lines) + "\n"


def check(rep, th) -> list:
    f, o, n, L = rep["factual"], rep["out_of_scope"], rep["no_live_data"], rep["latency"]
    fails = []
    for name, val, mn in (("fact_recall", f["fact_recall"], th["fact_recall_min"]),
                          ("full_fact_rate", f["full_fact_rate"], th["full_fact_rate_min"]),
                          ("source_hit", f["source_hit"], th["source_hit_min"]),
                          ("decline_rate", o["decline_rate"], th["decline_rate_min"]),
                          ("honest_rate", n["honest_rate"], th["honest_rate_min"])):
        if val < mn:
            fails.append(f"{name} {val} < required {mn}")
    if f["unsupported_number_rate"] > th["unsupported_number_rate_max"]:
        fails.append(f"unsupported_number_rate {f['unsupported_number_rate']} > allowed {th['unsupported_number_rate_max']}")
    if L["p95_ms"] > th["latency_p95_ms_max"]:
        fails.append(f"latency p95 {L['p95_ms']} > allowed {th['latency_p95_ms_max']}")
    return fails


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url")
    ap.add_argument("--llm", action="store_true")
    ap.add_argument("--judge", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=os.path.join(ROOT, "docs"))
    args = ap.parse_args()

    cases = json.load(open(os.path.join(HERE, "answer_cases.json"), encoding="utf-8"))
    kb_text = {d["id"]: d["text"] for d in json.load(open(os.path.join(BACKEND, "data", "knowledge_base.json"), encoding="utf-8"))}
    run, mode = make_runner(args)
    run("warm up")

    lat, det = [], {"factual": [], "out_of_scope": [], "no_live_data": []}
    for c in cases["factual"]:
        ans, src, ms = run(c["q"])
        lat.append(ms)
        r = {"id": c["id"], "q": c["q"], "answer": ans, "sources": src, **score_factual(c, ans, src, kb_text)}
        if hasattr(run, "context"):
            r.update(score_context(c, run.context(c["q"])))
        if args.judge:
            r["judge"] = judge(c, ans, src, kb_text)
        det["factual"].append(r)
    for c in cases["abstain"]:
        ans, _, ms = run(c["q"])
        lat.append(ms)
        det["out_of_scope"].append({"id": c["id"], "q": c["q"], "answer": ans, **score_abstain(ans, cases["decline_markers"])})
    for c in cases["no_live_data"]:
        ans, _, ms = run(c["q"])
        lat.append(ms)
        det["no_live_data"].append({"id": c["id"], "q": c["q"], "answer": ans, **score_no_live(ans, cases["honesty_markers"], cases["live_claims"])})

    rep = summarize(det["factual"], det["out_of_scope"], det["no_live_data"], lat, mode)
    os.makedirs(args.out, exist_ok=True)
    suffix = "" if mode.startswith("offline") else "_" + ("llm" if args.llm or args.url else "x")
    json.dump({"summary": rep, "details": det}, open(os.path.join(args.out, f"answer_eval_results{suffix}.json"), "w"), indent=1)
    md = render_md(rep, det)
    open(os.path.join(args.out, f"ANSWER_EVAL_REPORT{suffix}.md"), "w", encoding="utf-8").write(md)
    print(md)
    if args.check:
        fails = check(rep, json.load(open(os.path.join(HERE, "answer_thresholds.json"))))
        if fails:
            print("ANSWER EVALUATION GATE FAILED:\n  " + "\n  ".join(fails))
            sys.exit(1)
        print("Answer evaluation gate passed.")


if __name__ == "__main__":
    main()

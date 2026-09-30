"""Sends a batch of varied railway questions to /api/chat and prints how each
was handled (rules vs. agent), so you can eyeball answer quality quickly.

    python backend/tools/chat_smoke_test.py https://railway-rag-backend-h2d4.onrender.com
    python backend/tools/chat_smoke_test.py http://localhost:8000 --random 8
    python backend/tools/chat_smoke_test.py URL --ask "trains from Hyderabad to Vijayawada tomorrow"
"""
import argparse
import random
import sys
import time

import requests

QUESTIONS = [
    # rules / knowledge base (agent should NOT be needed)
    "When does Tatkal booking open for AC classes?",
    "What is the refund rule if my train is cancelled?",
    "What do RAC and waitlist mean?",
    "How many kg of luggage can I carry in sleeper class?",
    # live data (rules first, agent if provider fails)
    "What is the status of 20833",
    "Where is train 12951 now?",
    "Is train 12723 running late today?",
    "Schedule of train 12809",
    # routes / multi-step (agent territory)
    "trains from Hyderabad to Vijayawada tomorrow evening",
    "Cheapest way to go from Vijayawada to Chennai tomorrow",
    "Which stations are near Secunderabad?",
    "Alternative route from NDLS to MAS",
    "How crowded will 12951 be from NDLS to BCT in 3A?",
    # vague / typo / odd phrasing
    "my train is late what to do",
    "vande bharat vizag to hyderabad timing",
    "any train disruptions today due to fog",
    "pnr status 1234567890",
    # out of scope
    "what is the capital of France",
    "hi",
]


def ask(base, question, timeout):
    t0 = time.time()
    try:
        r = requests.post(f"{base.rstrip('/')}/api/chat", json={"message": question}, timeout=timeout)
        r.raise_for_status()
        d = r.json()
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}", "secs": time.time() - t0}
    d["secs"] = time.time() - t0
    return d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base_url")
    ap.add_argument("--random", type=int, help="ask N random questions instead of all")
    ap.add_argument("--ask", help="ask one custom question")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()

    qs = [a.ask] if a.ask else (random.sample(QUESTIONS, min(a.random, len(QUESTIONS))) if a.random else QUESTIONS)
    weak = 0
    for q in qs:
        d = ask(a.base_url, q, a.timeout)
        print(f"\nQ: {q}")
        if "answer" not in d:
            print(f"   REQUEST FAILED ({d['secs']:.1f}s): {d.get('error')}")
            weak += 1
            continue
        ag = d.get("agent") or {}
        tools = ", ".join(s["tool"] + ("" if s["ok"] else "(failed)") for s in ag.get("steps", []))
        route = f"agent[{ag.get('provider')}]: {tools or 'no tools'}" if ag.get("used") else \
            f"rules (intent={d.get('intent')})" + (f"  agent error: {ag['error']}" if ag.get("error") else "")
        answer = " ".join(d["answer"].split())
        bad = any(p in answer.lower() for p in ("not available", "something went wrong", "couldn't complete", "provided information"))
        weak += bad
        print(f"   {'WEAK ' if bad else 'OK   '}{d['secs']:.1f}s  {route}")
        print(f"   A: {answer[:220]}{'...' if len(answer) > 220 else ''}")
    print(f"\n{len(qs) - weak}/{len(qs)} answered usefully; {weak} weak/failed.")
    sys.exit(1 if weak else 0)


if __name__ == "__main__":
    main()

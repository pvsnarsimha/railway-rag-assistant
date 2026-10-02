#!/usr/bin/env python3
"""Rebuild backend/data/train_index.json (the bundled train-number list that
powers the Live Tracking train-number dropdown).

Sources, merged (later wins, so current names beat old ones):
  1. DataMeet's public Indian Railways dataset (older, ~5,000 trains).
  2. The existing train_index.json (keeps anything already collected).
  3. Optional --provider: sweeps every 2-digit number prefix (00-99) through
     your RapidAPI "Search Train" endpoint (needs RAPIDAPI_KEY in the
     environment / backend/.env). ~100 calls, so it sleeps between them; run
     it rarely (every few months), not on every deploy.

Usage:
    python tools/build_train_index.py                 # DataMeet + existing
    python tools/build_train_index.py --provider      # + live provider sweep
    python tools/build_train_index.py --offline       # existing file only
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "backend", "data", "train_index.json")
DATAMEET = "https://raw.githubusercontent.com/datameet/railways/master/trains.json"


def load_existing():
    try:
        with open(OUT, "r", encoding="utf-8") as f:
            return {r["n"]: r for r in json.load(f)}
    except Exception:
        return {}


def from_datameet():
    with urllib.request.urlopen(DATAMEET, timeout=120) as resp:
        data = json.load(resp)
    rows = {}
    for feat in data.get("features", []):
        p = feat.get("properties", {})
        n = str(p.get("number", "")).strip()
        if re.fullmatch(r"\d{5}", n):
            rows[n] = {"n": n, "name": (p.get("name") or "").strip().title(),
                       "from": p.get("from_station_code") or "", "to": p.get("to_station_code") or ""}
    return rows


def from_provider(sleep_s):
    sys.path.insert(0, os.path.join(ROOT, "backend"))
    try:
        from dotenv import load_dotenv
        load_dotenv(os.path.join(ROOT, "backend", ".env"))
    except Exception:
        pass
    import app as backend_app  # reuse the exact same defensive parser
    import rapidapi_provider
    rows = {}
    for i in range(100):
        prefix = f"{i:02d}"
        try:
            for r in backend_app._parse_provider_trains(rapidapi_provider.search_train(prefix)):
                rows[r["n"]] = r
            print(f"prefix {prefix}: {len(rows)} trains so far")
        except Exception as e:
            print(f"prefix {prefix}: skipped ({e})")
        time.sleep(sleep_s)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", action="store_true", help="also sweep the RapidAPI Search Train endpoint")
    ap.add_argument("--offline", action="store_true", help="do not download DataMeet")
    ap.add_argument("--sleep", type=float, default=1.5, help="seconds between provider calls")
    args = ap.parse_args()

    merged = {}
    if not args.offline:
        merged.update(from_datameet())
    for n, r in load_existing().items():
        merged[n] = {**merged.get(n, {}), **r}
    if args.provider:
        for n, r in from_provider(args.sleep).items():
            merged[n] = {**merged.get(n, {}), **r}
    rows = sorted(merged.values(), key=lambda r: r["n"])
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rows, f, separators=(",", ":"), ensure_ascii=False)
    print(f"wrote {len(rows)} trains to {OUT}")


if __name__ == "__main__":
    main()

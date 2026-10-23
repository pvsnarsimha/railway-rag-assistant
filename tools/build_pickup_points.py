#!/usr/bin/env python3
"""Build backend/data/station_pickup_points.json: real pickup spots (taxi / bus
stands, station entrances, named gates / clock towers / parcel offices) around
each station, from OpenStreetMap. Needs internet (run it locally or via the
'Build station pickup points' GitHub workflow). Resumable: stations already in
the output are skipped, and the file is saved as it goes.

  python tools/build_pickup_points.py --limit 500          # busiest 500 stations
  python tools/build_pickup_points.py --codes BZA NDLS HWH
"""
import argparse
import collections
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
import requests  # noqa: E402

import pickup_nav  # noqa: E402

OUT = os.path.join(ROOT, "backend", "data", "station_pickup_points.json")


def busiest_codes():
    """Stations ordered by how many trains start/end there and rail-network links."""
    n = collections.Counter()
    with open(os.path.join(ROOT, "backend", "data", "train_index.json"), encoding="utf-8") as f:
        for t in json.load(f):
            n[t.get("from")] += 1
            n[t.get("to")] += 1
    with open(os.path.join(ROOT, "backend", "data", "rail_network_edges.json"), encoding="utf-8") as f:
        for e in json.load(f):
            n[e.get("from")] += 1
            n[e.get("to")] += 1
    ranked = [c for c, _ in n.most_common() if c in pickup_nav._COORDS]
    return ranked + [c for c in pickup_nav._COORDS if c not in set(ranked)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=300, help="max stations to look up this run")
    ap.add_argument("--codes", nargs="*", help="only these station codes")
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between requests (be polite)")
    a = ap.parse_args()
    try:
        data = json.load(open(OUT, encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    todo = [c.upper() for c in a.codes] if a.codes else [c for c in busiest_codes() if c not in data]
    done = fails = 0
    for code in todo:
        if done >= a.limit or fails >= 8:
            break
        try:
            data[code] = pickup_nav.fetch_osm_points(code)
            done += 1
            fails = 0
            print(f"{code}: {len(data[code])} points", flush=True)
        except (requests.RequestException, ValueError) as e:
            fails += 1
            print(f"{code}: failed ({e})", flush=True)
        if done % 20 == 0:
            json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
        time.sleep(a.delay)
    json.dump(data, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"saved {len(data)} stations -> {OUT}")


if __name__ == "__main__":
    main()

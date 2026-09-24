"""
import_opencellid.py — seed cell_towers.db from OpenCelliD's open dataset.

1. Create a free account at https://opencellid.org and download the India
   files (MCC 404 and 405), e.g. `404.csv.gz`, `405.csv.gz`.
   Licence: CC BY-SA 4.0 — credit "OpenCelliD Project" in the app's About screen.
2. Run from backend/:
       python tools/import_opencellid.py 404.csv.gz 405.csv.gz --near-rail-km 5
   `--near-rail-km` keeps only towers within N km of a known railway station
   (data/station_coordinates.json, ~8,700 stations) so the DB stays small.

CSV columns (OpenCelliD): radio,mcc,net,area,cell,unit,lon,lat,range,samples,...
"""

import argparse
import csv
import gzip
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cell_tower_store  # noqa: E402


def _station_grid(cell_deg=0.1):
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "station_coordinates.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    items = data.values() if isinstance(data, dict) else data
    grid = {}
    for v in items:
        try:
            lat, lng = float(v.get("lat")), float(v.get("lng") or v.get("lon"))
        except (TypeError, ValueError, AttributeError):
            continue
        grid.setdefault((int(lat / cell_deg), int(lng / cell_deg)), []).append((lat, lng))
    return grid, cell_deg


def _near_station(lat, lng, grid, cell_deg, km):
    gx, gy = int(lat / cell_deg), int(lng / cell_deg)
    reach = int(km / 11) + 1
    for dx in range(-reach, reach + 1):
        for dy in range(-reach, reach + 1):
            for (slat, slng) in grid.get((gx + dx, gy + dy), ()):
                if math.hypot((lat - slat) * 110.57, (lng - slng) * 111.32 * math.cos(math.radians(lat))) <= km:
                    return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--near-rail-km", type=float, default=5.0)
    args = ap.parse_args()
    grid, cell_deg = _station_grid()
    batch, total = [], 0
    for path in args.files:
        opener = gzip.open if path.endswith(".gz") else open
        with opener(path, "rt", encoding="utf-8", errors="ignore") as f:
            for row in csv.reader(f):
                if not row or row[0] == "radio":
                    continue
                try:
                    radio, mcc, mnc, area, cid = row[0], int(row[1]), int(row[2]), int(row[3]), int(row[4])
                    lng, lat = float(row[6]), float(row[7])
                    samples = int(row[9]) if len(row) > 9 and row[9] else 1
                except (ValueError, IndexError):
                    continue
                if mcc not in (404, 405):
                    continue
                if args.near_rail_km and not _near_station(lat, lng, grid, cell_deg, args.near_rail_km):
                    continue
                batch.append({"radio": radio, "mcc": mcc, "mnc": mnc, "area": area, "cid": cid,
                              "lat": lat, "lng": lng, "samples": samples})
                if len(batch) >= 5000:
                    total += cell_tower_store.add_observations(batch, source="opencellid")
                    batch = []
    if batch:
        total += cell_tower_store.add_observations(batch, source="opencellid")
    print(f"Imported {total} towers. DB now: {cell_tower_store.stats()}")


if __name__ == "__main__":
    main()

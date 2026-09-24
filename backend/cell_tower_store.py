"""
cell_tower_store.py
-------------------
FEATURE (cell-tower offline tracking — server half).

RailYatri locates a phone WITHOUT internet by reading the serving cell
tower's ID and looking it up in a tower -> location table stored on the
phone. This module is that table's server side:

  * crowdsourced: app users who are online with a sharp GPS fix send
    (cell id, lat, lng) pairs — /api/offline/cell-observations — and each
    tower's position is kept as a running average of those real samples
    (the same way RailYatri built its own map);
  * optionally seeded in bulk from OpenCelliD's open dataset
    (tools/import_opencellid.py) — India is MCC 404/405;
  * before a journey, the phone downloads only the towers near ITS train's
    route — /api/offline/cell-map — and stores them for offline use.

Reading the cell ID on the phone needs a native Android module (see
mobile-app/native-modules-plan/cell-tower and
docs/CELL_TOWER_OFFLINE_PLAN.md) — browsers and Expo Go cannot.
"""

import math
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Iterable, List, Optional

_DB_PATH = os.environ.get(
    "CELL_TOWER_DB_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "cell_towers.db"),
)


@contextmanager
def _connect():
    conn = sqlite3.connect(_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cells (
                radio TEXT NOT NULL DEFAULT '',
                mcc INTEGER NOT NULL,
                mnc INTEGER NOT NULL,
                area INTEGER NOT NULL,
                cid INTEGER NOT NULL,
                lat REAL NOT NULL,
                lng REAL NOT NULL,
                samples INTEGER NOT NULL DEFAULT 1,
                source TEXT NOT NULL DEFAULT 'crowd',
                updated_at REAL NOT NULL,
                PRIMARY KEY (radio, mcc, mnc, area, cid)
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cells_latlng ON cells(lat, lng)")


def _valid(o: dict) -> bool:
    try:
        return (
            int(o["mcc"]) > 0 and int(o["mnc"]) >= 0 and int(o["area"]) >= 0 and int(o["cid"]) > 0
            and -90 <= float(o["lat"]) <= 90 and -180 <= float(o["lng"]) <= 180
        )
    except (KeyError, TypeError, ValueError):
        return False


def add_observations(observations: Iterable[dict], source: str = "crowd") -> int:
    """Running-average upsert. Returns how many were accepted."""
    now = time.time()
    n = 0
    with _connect() as conn:
        for o in observations:
            if not _valid(o):
                continue
            acc = o.get("accuracy")
            if acc is not None and float(acc) > 150:  # only sharp GPS fixes
                continue
            key = (str(o.get("radio") or "").upper(), int(o["mcc"]), int(o["mnc"]), int(o["area"]), int(o["cid"]))
            row = conn.execute(
                "SELECT lat, lng, samples FROM cells WHERE radio=? AND mcc=? AND mnc=? AND area=? AND cid=?", key
            ).fetchone()
            lat, lng = float(o["lat"]), float(o["lng"])
            if row is None:
                conn.execute(
                    "INSERT INTO cells (radio, mcc, mnc, area, cid, lat, lng, samples, source, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (*key, lat, lng, int(o.get("samples") or 1), source, now),
                )
            else:
                s = row["samples"]
                w = min(s, 200)  # cap history weight so a moved tower can re-converge
                conn.execute(
                    "UPDATE cells SET lat=?, lng=?, samples=?, updated_at=? "
                    "WHERE radio=? AND mcc=? AND mnc=? AND area=? AND cid=?",
                    ((row["lat"] * w + lat) / (w + 1), (row["lng"] * w + lng) / (w + 1), s + 1, now, *key),
                )
            n += 1
    return n


def _km_to_segment(lat, lng, a, b) -> float:
    kx = math.cos(math.radians((a[0] + b[0]) / 2)) * 111.32
    ky = 110.57
    ax, ay, bx, by = a[1] * kx, a[0] * ky, b[1] * kx, b[0] * ky
    px, py = lng * kx, lat * ky
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def cells_near_route(points: List[List[float]], radius_km: float = 5.0, limit: int = 20000) -> List[dict]:
    """Every known tower within radius_km of the polyline through `points`
    ([[lat, lng], ...] — the train's station coordinates in route order)."""
    pts = [(float(p[0]), float(p[1])) for p in points if p and len(p) >= 2 and p[0] is not None and p[1] is not None]
    if len(pts) < 2:
        return []
    pad = radius_km / 110.0 + 0.05
    lat_min, lat_max = min(p[0] for p in pts) - pad, max(p[0] for p in pts) + pad
    lng_min, lng_max = min(p[1] for p in pts) - pad * 1.2, max(p[1] for p in pts) + pad * 1.2
    with _connect() as conn:
        rows = conn.execute(
            "SELECT radio, mcc, mnc, area, cid, lat, lng, samples FROM cells "
            "WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?",
            (lat_min, lat_max, lng_min, lng_max),
        ).fetchall()
    out = []
    for r in rows:
        if any(_km_to_segment(r["lat"], r["lng"], pts[i], pts[i + 1]) <= radius_km for i in range(len(pts) - 1)):
            out.append(dict(r))
            if len(out) >= limit:
                break
    return out


def stats() -> dict:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n, COALESCE(SUM(samples), 0) AS s FROM cells").fetchone()
        return {"towers": row["n"], "samples": row["s"]}


init_db()

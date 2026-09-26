"""
ui_translate.py
---------------
FEATURE: the whole screen in the user's language (Home, Railway Assistant,
Live Tracking): headings, labels AND station / train names, for English +
the 22 Eighth-Schedule languages.

POST /api/translate {lang, texts:[...]} -> {translations:[...]} (same order).

How each string is translated, in order:
  1. cache (memory + a small SQLite file, so a station name is translated
     once for everybody, not on every screen refresh),
  2. the app's own LLM (Gemini, then Claude — the same keys the Railway
     Assistant already uses), asked for a JSON array in one call. It is told
     to TRANSLITERATE station / train / place names into the target script
     ("Katpadi Jn" -> "కాట్పాడి జం.") and to translate everything else,
  3. Google's public translate endpoint, string by string,
  4. otherwise the English text is returned unchanged (never an error on
     screen).
"""

import json
import logging
import os
import re
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from typing import Callable, List, Optional, Tuple

import requests

import i18n_notify

logger = logging.getLogger(__name__)

_DB_PATH = os.environ.get(
    "UI_TRANSLATE_DB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui_translate_cache.db"))
_lock = threading.Lock()
_mem = {}  # (lang, text) -> translation
MAX_TEXTS = 150
MAX_LEN = 2000
# Seconds to wait for the LLM before handing the rest to Google.
LLM_BUDGET_S = float(os.environ.get("UI_TRANSLATE_LLM_BUDGET_S", "14"))

# Google Translate language codes where they differ from ours.
_GT_CODE = {"kok": "gom", "mni": "mni-Mtei"}


def _db():
    conn = sqlite3.connect(_DB_PATH, timeout=10)
    conn.execute("CREATE TABLE IF NOT EXISTS tr (lang TEXT, src TEXT, dst TEXT, PRIMARY KEY (lang, src))")
    return conn


def _cache_get(lang: str, texts: List[str]) -> dict:
    out = {}
    missing = []
    for t in texts:
        k = (lang, t)
        if k in _mem:
            out[t] = _mem[k]
        else:
            missing.append(t)
    if missing:
        try:
            with _lock, _db() as conn:
                for i in range(0, len(missing), 200):
                    chunk = missing[i:i + 200]
                    q = "SELECT src, dst FROM tr WHERE lang = ? AND src IN (%s)" % ",".join("?" * len(chunk))
                    for src, dst in conn.execute(q, [lang, *chunk]):
                        _mem[(lang, src)] = dst
                        out[src] = dst
        except Exception as e:  # noqa: BLE001
            logger.warning("translate cache read failed: %s", e)
    return out


def _cache_put(lang: str, pairs: dict) -> None:
    if not pairs:
        return
    for s, d in pairs.items():
        _mem[(lang, s)] = d
    try:
        with _lock, _db() as conn:
            conn.executemany("INSERT OR REPLACE INTO tr (lang, src, dst) VALUES (?, ?, ?)",
                             [(lang, s, d) for s, d in pairs.items()])
    except Exception as e:  # noqa: BLE001
        logger.warning("translate cache write failed: %s", e)


def _skip(text: str) -> bool:
    """Nothing to translate: numbers, times, codes like 'KPD', '12295'."""
    t = text.strip()
    return (not t) or not re.search(r"[A-Za-z]{2,}", t) or bool(re.fullmatch(r"[A-Z]{2,5}", t))


def _keeps_placeholders(src: str, dst: str) -> bool:
    """The app masks numbers as {0}, {1}… (and uses {n}-style templates);
    a translation that lost one would show a sentence with a hole in it."""
    return all(p in dst for p in re.findall(r"\{\w+\}", src))


def _llm_batch(lang: str, texts: List[str], llm: Callable) -> dict:
    name = i18n_notify.LANGUAGES[lang][0]
    system = (
        f"You translate the user interface of an Indian Railways train-tracking app into {name}. "
        f"Reply with ONLY a JSON array of strings, same length and order as the input array. Rules: "
        f"(1) Railway station, train, city and place names must be TRANSLITERATED into {name} script "
        f"(write how the name sounds), never translated word by word; keep 'Jn' as the {name} "
        f"abbreviation for Junction. (2) Everything else is translated naturally and briefly, the way "
        f"a {name} railway app or station board would say it. (3) Keep numbers, times (13:38), "
        f"station codes in brackets (KPD), train numbers, emoji and punctuation exactly as they are. "
        f"(4) Keep the placeholder words unchanged if any appear in curly braces."
    )
    user = json.dumps(texts, ensure_ascii=False)
    answer, _err, _prov = llm(system, user)
    if not answer:
        return {}
    m = re.search(r"\[.*\]", answer, re.S)
    if not m:
        return {}
    try:
        arr = json.loads(m.group(0))
    except ValueError:
        return {}
    if not isinstance(arr, list) or len(arr) != len(texts):
        return {}
    return {s: str(d) for s, d in zip(texts, arr)
            if isinstance(d, (str, int, float)) and str(d).strip() and _keeps_placeholders(s, str(d))}


def _google_one(lang: str, text: str) -> Optional[str]:
    try:
        r = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": "en", "tl": _GT_CODE.get(lang, lang), "dt": "t", "q": text},
            timeout=8,
        )
        if not r.ok:
            return None
        data = r.json()
        out = "".join(seg[0] for seg in (data[0] or []) if seg and seg[0])
        return out.strip() or None
    except Exception:  # noqa: BLE001
        return None


def translate(lang: str, texts: List[str], llm: Optional[Callable] = None) -> Tuple[List[str], str]:
    """Returns (translations in input order, source-of-new-ones)."""
    out, source, _ok = translate_ex(lang, texts, llm)
    return out, source


def translate_ex(lang: str, texts: List[str], llm: Optional[Callable] = None) -> Tuple[List[str], str, List[bool]]:
    """Like translate(), plus ok[i] = False when text i could NOT be
    translated right now (every backend failed / timed out) and was returned
    in English only as a stop-gap. The app must not remember those as the
    final translation — it asks again later — otherwise one slow first
    request would leave the screen in English for good.

    Speed matters most the first time a language is chosen (a whole screen
    of new strings): LLM batches run in parallel with a time budget, and
    whatever is still missing goes to Google in parallel."""
    lang = i18n_notify.normalize(lang)
    texts = [str(t)[:MAX_LEN] for t in (texts or [])][:MAX_TEXTS]
    if lang == "en" or not texts:
        return texts, "none", [True] * len(texts)
    todo = sorted({t for t in texts if not _skip(t)})
    have = _cache_get(lang, todo)
    missing = [t for t in todo if t not in have]
    source = "cache"
    if missing and llm is not None:
        got = {}
        batches = [missing[i:i + 25] for i in range(0, len(missing), 25)]
        pool = ThreadPoolExecutor(max_workers=min(6, len(batches)))
        futures = [pool.submit(_llm_batch, lang, b, llm) for b in batches]
        done, _pending = wait(futures, timeout=LLM_BUDGET_S)
        for f in done:
            try:
                got.update(f.result() or {})
            except Exception as e:  # noqa: BLE001
                logger.warning("translate llm batch failed: %s", e)
        pool.shutdown(wait=False)  # late batches finish in the background and are dropped
        if got:
            _cache_put(lang, got)
            have.update(got)
            source = "llm"
        missing = [t for t in missing if t not in have]
    if missing:
        got = {}
        with ThreadPoolExecutor(max_workers=min(12, len(missing))) as pool:
            for t, d in zip(missing, pool.map(lambda x: _google_one(lang, x), missing)):
                if d and _keeps_placeholders(t, d):
                    got[t] = d
        if got:
            _cache_put(lang, got)
            have.update(got)
            source = "google" if source == "cache" else source + "+google"
    ok = [(t in have) or _skip(t) for t in texts]
    return [have.get(t, t) for t in texts], source, ok

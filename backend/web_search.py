"""
web_search.py
--------------
FEATURE: Web Search fallback for passenger questions asked from the Live
Tracking tab (mobile app).

The existing Advanced RAG pipeline (rag_engine.py) answers from a fixed,
curated knowledge_base.json using hybrid retrieval + semantic search. That's
great for railway *policy* questions ("what is RAC", "Tatkal refund rules")
but has nothing to say about things that change day to day and aren't in
any static file — "is there fog disruption on the Delhi route today", "why
do trains get delayed near a level crossing", real train listings for a
specific route/date, etc. Those get answered by live web search instead.

Three providers, tried in this order:

1. Tavily Search API — used automatically when TAVILY_API_KEY is set.
   Purpose-built for feeding LLM pipelines (returns clean, already-summarized
   content per result, not raw snippets), generous free tier (1,000
   searches/month), and the recommended option — get a key at
   https://tavily.com (sign up, key is on the dashboard immediately, no
   credit card needed for the free tier).
2. Bing Web Search API (Azure AI Search) — used automatically when
   TAVILY_API_KEY isn't set but BING_SEARCH_API_KEY is. Real indexed search
   results too; get a key at https://portal.azure.com (create a "Bing
   Search v7" resource — has a free F1 tier).
3. DuckDuckGo HTML-only endpoint — used automatically when neither of the
   above is configured, so the feature still works out of the box with
   zero setup. This is a scrape (no official free API), so it's noticeably
   more fragile: DuckDuckGo can rate-limit or change markup at any time.
   Fine for development/demos; set TAVILY_API_KEY for anything real.

All three fail soft — every function here returns an empty list rather than
raising, so a passenger question always still gets *some* answer from the
semantic/RAG path even if the web lookup didn't come through.

Contract:
    search_web(query, max_results=3) -> List[WebSearchResult]
"""

import os
import re
import html
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import quote_plus, unquote, urlparse, parse_qs

import requests

from api_cache import cached

TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()
TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search"

BING_SEARCH_API_KEY = os.getenv("BING_SEARCH_API_KEY", "").strip()
# Regional/sovereign Bing endpoints differ (e.g. Azure China) — overridable,
# defaults to the standard global endpoint everyone gets from a normal
# "Bing Search v7" resource in the Azure portal.
BING_SEARCH_ENDPOINT = os.getenv("BING_SEARCH_ENDPOINT", "https://api.bing.microsoft.com/v7.0/search").strip()

_SEARCH_URL = "https://html.duckduckgo.com/html/"
_TIMEOUT_SECONDS = 6
_HEADERS = {
    # A plain desktop-browser UA — DuckDuckGo's lite/html endpoint is happy
    # to serve this without JS or cookies.
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

# DuckDuckGo's HTML result markup, roughly:
#   <a class="result__a" href="...">Title text</a>
#   <a class="result__snippet" ...>Snippet text</a>
_RESULT_LINK_RE = re.compile(
    r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.DOTALL
)
_SNIPPET_RE = re.compile(
    r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>', re.DOTALL
)
_TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class WebSearchResult:
    title: str
    snippet: str
    url: str


def _clean(fragment: str) -> str:
    """Strip inner HTML tags and unescape entities from a matched fragment."""
    text = _TAG_RE.sub("", fragment or "")
    return html.unescape(text).strip()


def _resolve_ddg_redirect(href: str) -> str:
    """DuckDuckGo's HTML endpoint wraps result URLs in a redirect
    (//duckduckgo.com/l/?uddg=<real-url>&...). Pull the real URL out so the
    frontend can link straight to the source instead of bouncing through
    DDG."""
    if "uddg=" in href:
        try:
            qs = parse_qs(urlparse(href).query)
            real = qs.get("uddg", [None])[0]
            if real:
                return unquote(real)
        except Exception:
            pass
    return href


def _search_tavily(query: str, max_results: int) -> List["WebSearchResult"]:
    """Tavily's Search API — used whenever TAVILY_API_KEY is configured.
    Purpose-built for LLM pipelines: each result comes with `content`
    already extracted/cleaned from the page (not a raw meta-description
    snippet), which tends to give the synthesis step more to actually work
    with than a one-line search snippet. Raises on failure; callers catch
    and fall back to Bing/DuckDuckGo below, so a Tavily outage/quota issue
    never breaks the feature, just quietly drops to the next path for that
    request."""
    resp = requests.post(
        TAVILY_SEARCH_ENDPOINT,
        json={
            "api_key": TAVILY_API_KEY,
            "query": query,
            "max_results": max_results,
            "search_depth": "basic",
            # Indian Railways queries skew heavily to Indian train-enquiry
            # sites (erail, ixigo, railyatri, trainman, etc.) - no country
            # filter param exists here, but "basic" depth with a specific
            # enough query (station codes/date already folded in by the
            # caller) does the job without needing one.
        },
        timeout=_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    data = resp.json()
    raw_results = data.get("results") or []
    results = []
    for r in raw_results[:max_results]:
        title = (r.get("title") or "").strip()
        url = (r.get("url") or "").strip()
        # Tavily's `content` is pre-extracted page text, already reasonably
        # concise - cap it so one very long result doesn't crowd out the
        # others in the synthesis prompt's context window.
        snippet = (r.get("content") or "").strip()[:400]
        if not title or not url:
            continue
        results.append(WebSearchResult(title=title, snippet=snippet, url=url))
    return results


def _search_bing(query: str, max_results: int) -> List["WebSearchResult"]:
    """Real Bing Web Search API results — used whenever BING_SEARCH_API_KEY
    is configured. Raises on failure; callers catch and fall back to the
    DuckDuckGo scrape below, so a Bing outage/quota issue never breaks the
    feature, just quietly drops to the free path for that request."""
    resp = requests.get(
        BING_SEARCH_ENDPOINT,
        headers={"Ocp-Apim-Subscription-Key": BING_SEARCH_API_KEY},
        params={
            "q": query,
            "count": max_results,
            "mkt": "en-IN",       # Indian Railways queries skew heavily to Indian sources/results
            "textDecorations": "false",
            "textFormat": "Raw",
            "safeSearch": "Moderate",
        },
        timeout=_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    data = resp.json()
    pages = (data.get("webPages") or {}).get("value") or []
    results = []
    for p in pages[:max_results]:
        title = (p.get("name") or "").strip()
        url = (p.get("url") or "").strip()
        snippet = (p.get("snippet") or "").strip()
        if not title or not url:
            continue
        results.append(WebSearchResult(title=title, snippet=snippet, url=url))
    return results


def _search_duckduckgo(query: str, max_results: int) -> List[WebSearchResult]:
    """Free, no-key fallback: scrapes DuckDuckGo's HTML-only endpoint (the
    same one screen readers and no-JS browsers get). No official free API
    exists for this, so it's inherently more fragile than Bing above —
    DuckDuckGo can rate-limit or change markup at any time — but it means
    web search still works with zero configuration."""
    try:
        resp = requests.post(
            _SEARCH_URL,
            data={"q": query},
            headers=_HEADERS,
            timeout=_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
    except Exception:
        return []

    try:
        links = _RESULT_LINK_RE.findall(resp.text)
        snippets = _SNIPPET_RE.findall(resp.text)
    except Exception:
        return []

    results: List[WebSearchResult] = []
    for i, (href, title_html) in enumerate(links[:max_results]):
        title = _clean(title_html)
        snippet = _clean(snippets[i]) if i < len(snippets) else ""
        url = _resolve_ddg_redirect(href)
        if not title or not url:
            continue
        results.append(WebSearchResult(title=title, snippet=snippet, url=url))

    return results[:max_results]


@cached(ttl_seconds=900, prefix="web_search")  # 15 min — news/live topics move, but not that fast
def search_web(query: str, max_results: int = 3) -> List[WebSearchResult]:
    """
    Runs a live web search and returns up to `max_results` (title, snippet,
    url) results. Never raises — on any network/parsing failure this
    returns an empty list so the caller can carry on with whatever else it
    has (RAG chunks, live data, etc.) rather than failing the whole
    passenger question.

    Tries Tavily first if TAVILY_API_KEY is configured (purpose-built for
    LLM use, the recommended option); then Bing Web Search API if
    BING_SEARCH_API_KEY is set instead; falls back to a DuckDuckGo HTML
    scrape when neither key is configured, or if a configured provider's
    call itself fails (quota exceeded, key revoked, transient outage) so a
    provider hiccup never takes web search down entirely.
    """
    query = (query or "").strip()
    if not query:
        return []

    if TAVILY_API_KEY:
        try:
            results = _search_tavily(query, max_results)
            if results:
                return results
        except Exception:
            pass  # fall through to Bing/DuckDuckGo below

    if BING_SEARCH_API_KEY:
        try:
            results = _search_bing(query, max_results)
            if results:
                return results
        except Exception:
            pass  # fall through to the free DuckDuckGo path below

    return _search_duckduckgo(query, max_results)


def format_results_for_context(results: List[WebSearchResult]) -> Optional[str]:
    """Plain-text block ready to drop into the LLM synthesis prompt as a
    context section. Returns None when there's nothing to add, so callers
    can skip the section entirely rather than adding an empty header."""
    if not results:
        return None
    lines = []
    for r in results:
        line = f"- {r.title}"
        if r.snippet:
            line += f": {r.snippet}"
        line += f" (source: {r.url})"
        lines.append(line)
    return "\n".join(lines)

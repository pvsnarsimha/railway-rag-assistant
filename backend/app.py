"""
app.py
-------
FastAPI backend for the Indian Railways RAG Assistant.

Flow per user message (now with the advanced RAG pipeline):
  0. (optional) an attached ticket photo is read via Claude vision to pull
     out a PNR / train number the user didn't type -> multimodal.py
  1. query_router.classify()  -> intent + extracted entities
  2. If intent needs live data -> railway_api.py call (real provider, real key)
  3. rag_engine.AdvancedRAGEngine.retrieve() runs the full pipeline:
     Self-RAG retrieval gate -> Hybrid (BM25 + semantic) search -> Graph RAG
     1-hop expansion -> Contextual compression -> diagram lookup
  4. Everything gathered (live data + retrieved/compressed chunks + any
     diagrams + the original question) is handed to Claude to produce one
     natural-language, grounded answer. If ANTHROPIC_API_KEY isn't set, a
     clear templated answer is returned instead of silently degrading or
     fabricating a response.

Run:
    uvicorn app:app --reload --port 8000
Then open http://localhost:8000 in a browser.
"""

import asyncio
import json
import os
import re
import time
import traceback
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

from dotenv import load_dotenv
_ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
_env_loaded = load_dotenv(dotenv_path=_ENV_PATH)

import query_router
import railway_api
import gps_tracking
import railradar_fallback
import weather
import trains_between
import nearby_stations
import route_planner
import crowd_prediction
import language_support
import delay_prediction
import delay_explainability
import crowd_position_store
import crowd_position_tracking
import station_search
import analytics
import advanced_features
import journey_planner
import historical_delay
import pnr_tracking
import reroute_suggestions
import route_deviation
import connection_risk
import coach_crowd_store
import public_share
import alt_transport
from deep_extract import top_level_keys
from api_cache import cache_stats
from help_content import build_help_answer
import rag_engine
from rag_engine import get_engine
from multimodal import extract_entities_from_image
import feedback_rlhf
import few_shot_intents
import sentiment_analysis
import auto_keyword_discovery
import entity_gazetteer
import web_search
import push_store
import push_notifications
import alert_scheduler
import smart_features

app = FastAPI(title="Indian Railways RAG Assistant")

_TRACK_POLL_INTERVAL_SECONDS = 5

FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
MOBILE_WEB_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "mobile_web")


@app.on_event("startup")
def _startup_diagnostics():
    print(f"[startup] .env path: {_ENV_PATH} (found on disk: {os.path.isfile(_ENV_PATH)}, loaded: {_env_loaded})")
    print(f"[startup] RAPIDAPI_KEY set: {bool(os.environ.get('RAPIDAPI_KEY', '').strip())}")
    print(f"[startup] GEMINI_API_KEY set: {bool(os.environ.get('GEMINI_API_KEY', '').strip())} (primary — text synthesis)")
    print(f"[startup] ANTHROPIC_API_KEY set: {bool(os.environ.get('ANTHROPIC_API_KEY', '').strip())} (ticket-photo vision + text-synthesis fallback)")
    # Warm up the RAG engine (builds BM25 index, semantic embeddings, entity
    # graph) once at startup instead of on the first user request.
    engine = get_engine()
    print(f"[startup] RAG engine ready. Semantic backend: {engine.hybrid.semantic_engine_name}")
    # Warm up the delay-prediction model (trains/loads once) so the first
    # real request isn't the one paying for it.
    delay_prediction.get_model()
    print(f"[startup] Delay prediction model ready: {delay_prediction._model_name}")

    # Push notifications: same "reuse the real prediction pipeline" call
    # /api/advanced/alerts/check makes, just invoked on a timer instead of
    # on-demand. See push_notifications.py's status() for why this can be
    # left unconfigured without breaking anything else.
    push_status = push_notifications.status()
    print(f"[startup] Push notifications configured: {push_status['configured']}"
          + (f" ({push_status['detail']})" if not push_status["configured"] else ""))

    def _predict_delay_for_watch(train_number: str, date, label=None):
        # FEATURE: label-aware delay alerts — a watch's label is now
        # resolved against the train's real live timeline (see
        # _predict_for_watch_station) so push notifications only fire for
        # a real station on this train's route, skip entirely for a
        # mistyped/non-route label, and say "already reached at HH:MM"
        # instead of a meaningless prediction once the train has passed
        # it. `label` is a new optional 3rd arg — alert_scheduler passes
        # it when calling this closure; not passing one falls back to the
        # exact prior "predict for the next reporting station" behavior.
        return _predict_for_watch_station(train_number, date, label)

    _interval = int(os.environ.get("ALERT_CHECK_INTERVAL_MINUTES", "15") or "15")
    # FEATURE: Fare & Availability "Alert Zone" — same dependency-injection
    # pattern as the delay watch above: alert_scheduler never imports
    # app.py directly, it's handed a plain callable that wraps the real
    # railway_api fare/availability calls (see _fare_check_for_watch,
    # defined further down — resolved at call time, not at startup, so
    # its later definition in this module is fine here).
    _fare_interval = int(os.environ.get("FARE_ALERT_CHECK_INTERVAL_MINUTES", str(alert_scheduler.DEFAULT_FARE_CHECK_INTERVAL_MINUTES)) or alert_scheduler.DEFAULT_FARE_CHECK_INTERVAL_MINUTES)
    # FEATURE: Background-surviving Smart Alarm — same dependency-injection
    # pattern as the delay/fare closures above. `_alarm_check_for_watch` is
    # defined further down (resolved at call time) and wraps
    # smart_features.smart_alarm_check exactly like /api/advanced/smart-alarm
    # does, so the background job and the on-demand endpoint never diverge.
    _alarm_interval = int(os.environ.get("ALARM_CHECK_INTERVAL_MINUTES", str(alert_scheduler.DEFAULT_ALARM_CHECK_INTERVAL_MINUTES)) or alert_scheduler.DEFAULT_ALARM_CHECK_INTERVAL_MINUTES)
    alert_scheduler.start(
        _predict_delay_for_watch, interval_minutes=_interval,
        fare_check_fn=_fare_check_for_watch, fare_check_interval_minutes=_fare_interval,
        alarm_check_fn=_alarm_check_for_watch, alarm_check_interval_minutes=_alarm_interval,
    )


@app.on_event("shutdown")
def _shutdown_scheduler():
    alert_scheduler.stop()


@app.get("/api/health")
def health():
    """Diagnostic endpoint — confirms whether keys are actually loaded, without leaking values."""
    engine = get_engine()
    return {
        "env_file_found": os.path.isfile(_ENV_PATH),
        "env_file_path": _ENV_PATH,
        "rapidapi_key_loaded": bool(os.environ.get("RAPIDAPI_KEY", "").strip()),
        "gemini_key_loaded": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
        "anthropic_key_loaded": bool(os.environ.get("ANTHROPIC_API_KEY", "").strip()),
        "web_search_provider": "bing" if web_search.BING_SEARCH_API_KEY else "duckduckgo (no BING_SEARCH_API_KEY set)",
        "semantic_engine": engine.hybrid.semantic_engine_name,
        "kb_entries": len(engine.docs),
        "api_cache": cache_stats(),
    }


class ChatRequest(BaseModel):
    message: str
    image_base64: Optional[str] = None
    image_media_type: Optional[str] = None
    language: Optional[str] = None  # "auto" / "" / a language name from the frontend dropdown
    # Live-tracking context (set by the mobile app's "Ask about this train"
    # box on the Live Tracking tab): the train already being tracked, so a
    # question like "why might it be delayed today" doesn't need the user
    # to retype the train number. Folded into the question text below,
    # same trick already used for the ticket-photo extraction path — no
    # second code path needed, the existing rule-based router just sees it.
    train_number: Optional[str] = None
    # Explicit UI toggles (mic/web-search/deep-think buttons in the app):
    # both null-safe so older app builds that don't send them yet keep
    # today's automatic behavior unchanged.
    web_search: Optional[bool] = None   # True: force a web lookup even outside the usual auto-trigger cases.
                                         # False: skip web search even if it would have auto-triggered.
                                         # None/omitted: today's automatic intent-based behavior.
    deep_think: bool = False            # True: broaden retrieval (more chunks) and ask the model to
                                         # reason step-by-step through multiple angles before answering.


# How many extra attempts to give Gemini's OWN transient capacity errors
# (503 UNAVAILABLE / "high demand", not a real config problem — the model
# was reachable, just overloaded at that instant) before giving up and
# letting _call_llm_for_synthesis() fall through to Claude. A real auth/
# config failure (401, 400, etc.) is NOT retried here — retrying those
# just burns time on an error that will never change on its own.
_GEMINI_MAX_RETRIES = 2
_GEMINI_RETRY_BASE_DELAY_SECONDS = 2


def _is_transient_gemini_error(exc: Exception) -> bool:
    text = str(exc).upper()
    return "503" in text or "UNAVAILABLE" in text


def _call_gemini(system_prompt: str, user_prompt: str):
    """Calls Gemini for final answer synthesis (text only — GPS, live status,
    routes, policy/FAQ, everything _synthesize() handles). Requires
    GEMINI_API_KEY.

    This is the PRIMARY synthesis path — Gemini is far cheaper per token
    than Claude for plain text-in/text-out work, and none of this data
    (railway data, KB excerpts) is ever generated by the model itself, only
    phrased — so a cheaper text model is a safe swap here. Ticket-photo
    reading stays on Claude vision (see multimodal.py) since that one path
    is accuracy-critical in a way plain synthesis is not.

    Returns (answer_text_or_None, error_message_or_None), same contract as
    _call_claude(): (None, None) means "no key configured, try the next
    provider quietly"; (None, error) means "a key was found but the call
    failed" and should be surfaced, not swallowed.
    """
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None, None

    try:
        from google import genai
        client = genai.Client(api_key=api_key)
    except Exception as exc:
        return None, f"Gemini synthesis call failed ({type(exc).__name__}): {exc}"
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")

    last_exc = None
    for attempt in range(_GEMINI_MAX_RETRIES + 1):
        try:
            response = client.models.generate_content(
                model=model,
                contents=user_prompt,
                config={
                    "system_instruction": system_prompt,
                    # 600 was too low for long structured answers (e.g. a full
                    # train schedule with 30-40 stops) — it was cutting the
                    # response off mid-sentence instead of finishing the list.
                    # 2048 gives real headroom for those while short answers
                    # (GPS, PNR status) still finish in a fraction of that.
                    "max_output_tokens": 2048,
                    # This call never registers any `tools=`, so there is no
                    # automatic function calling (AFC) happening here in the
                    # first place — but newer google-genai versions still print
                    # "Direct use of AFC in Models.generate_content is not
                    # recommended... use Chat.send_message" on every call
                    # regardless. Explicitly disabling AFC (rather than leaving
                    # the SDK default) silences that warning with zero behavior
                    # change, since nothing here was relying on AFC anyway.
                    # Switching this whole call to client.chats.create() +
                    # chat.send_message() would be the SDK's longer-term
                    # preferred shape, but this one-shot, stateless synthesis
                    # call (fresh system+user prompt every time, no multi-turn
                    # state) has no real use for a persistent Chat object.
                    "automatic_function_calling": {"disable": True},
                },
            )
            text = (response.text or "").strip()
            if not text:
                return None, "Gemini synthesis call returned an empty response."

            # If Gemini stopped because it hit the token cap (not because it was
            # actually done), surface that instead of silently returning a
            # sentence that stops mid-word — that's exactly the failure mode
            # that produced the truncated schedule seen in testing.
            try:
                finish_reason = response.candidates[0].finish_reason
            except (AttributeError, IndexError, TypeError):
                finish_reason = None
            if finish_reason is not None and str(finish_reason).upper().endswith("MAX_TOKENS"):
                return None, "Gemini's response was cut off by the output-token limit before finishing."

            return text, None
        except Exception as exc:
            last_exc = exc
            # BUGFIX: a 503 "high demand" spike from Google's own servers was
            # being treated exactly like a real config failure (bad key,
            # wrong model name, etc.) — surfaced to the user immediately with
            # no retry, even though the very same request often succeeds a
            # couple seconds later once Google's capacity spike clears. Only
            # THIS specific transient-error shape gets retried (a short,
            # increasing backoff — 2s, then 4s); anything else (401, 400,
            # model-not-found) fails fast on the first attempt, same as
            # before, since retrying those would just waste time on an error
            # that isn't going to change.
            if attempt < _GEMINI_MAX_RETRIES and _is_transient_gemini_error(exc):
                time.sleep(_GEMINI_RETRY_BASE_DELAY_SECONDS * (attempt + 1))
                continue
            return None, f"Gemini synthesis call failed ({type(exc).__name__}): {exc}"
    return None, f"Gemini synthesis call failed ({type(last_exc).__name__}): {last_exc}"


def _call_claude(system_prompt: str, user_prompt: str):
    """Calls Claude for final answer synthesis. Requires ANTHROPIC_API_KEY.

    This is the FALLBACK text-synthesis path, used only when GEMINI_API_KEY
    isn't set or the Gemini call itself failed — see _call_gemini() above
    for the primary path and why Gemini is preferred here. Claude remains
    the ONLY path for ticket-photo reading (multimodal.py), which is
    untouched by this fallback ordering.

    Returns (answer_text_or_None, error_message_or_None). A None answer with
    a None error means "no key configured, use the fallback quietly". A None
    answer WITH an error means "a key was found but the call failed" — that
    error is surfaced instead of being swallowed, so a misconfigured model
    name or an expired key shows up clearly instead of looking like sample data.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return None, None

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")

        response = client.messages.create(
            model=model,
            max_tokens=2048,  # was 600 — too low for long schedules/lists, cut answers off mid-sentence
            system=system_prompt,
            messages=[{"role": "user", "content": user_prompt}],
        )
        text = "".join(block.text for block in response.content if block.type == "text")
        if response.stop_reason == "max_tokens":
            return None, "Claude's response was cut off by the output-token limit before finishing."
        return text, None
    except Exception as exc:
        return None, f"Claude synthesis call failed ({type(exc).__name__}): {exc}"


def _call_llm_for_synthesis(system_prompt: str, user_prompt: str):
    """Tries Gemini first (cheap — handles GPS/live-status/routes/FAQ text
    synthesis), falls back to Claude if Gemini has no key or fails, and
    otherwise signals "no provider available" so the caller can use the
    templated fallback.

    Returns (answer_text_or_None, error_message_or_None, provider_used).
    provider_used is "gemini", "claude", or None.
    """
    answer, error = _call_gemini(system_prompt, user_prompt)
    if answer:
        return answer, None, "gemini"
    gemini_error = error  # stays None if Gemini simply had no key configured

    answer, error = _call_claude(system_prompt, user_prompt)
    if answer:
        return answer, None, "claude"

    # Neither provider produced an answer — prefer surfacing whichever one
    # actually had a key configured and failed, over silently reporting
    # "no key" if one of the two was genuinely misconfigured.
    final_error = error or gemini_error   # Claude's error wins if Claude actually tried and failed
    return None, final_error, None


def _synthesize(question: str, live_data: dict, retrieval, live_error: str = None,
                 language_choice: "language_support.LanguageChoice" = None,
                 sentiment_result: "sentiment_analysis.SentimentResult" = None,
                 reasoning_paths: Optional[List[str]] = None,
                 few_shot_hint: Optional[str] = None,
                 web_results: Optional[List["web_search.WebSearchResult"]] = None,
                 deep_think: bool = False) -> str:
    """Builds the grounded prompt and gets a final NL answer, with a safe fallback."""
    context_parts = []
    if live_data:
        context_parts.append(f"LIVE RAILWAY DATA (real-time, from railway data provider):\n{live_data}")
    if live_error:
        context_parts.append(f"LIVE DATA LOOKUP ERROR (explain this plainly to the user, don't invent data):\n{live_error}")
    if retrieval.chunks:
        kb_text = "\n\n".join(f"[{c.category}] {c.compressed_text}" for c in retrieval.chunks)
        context_parts.append(f"RELEVANT RAILWAY POLICY / KNOWLEDGE BASE EXCERPTS (already compressed to the most relevant sentences):\n{kb_text}")
    web_context = web_search.format_results_for_context(web_results) if web_results else None
    if web_context:
        context_parts.append(
            "LIVE WEB SEARCH RESULTS (current-as-of-today, from the open web — use only "
            "for things the sources above don't cover, e.g. today's disruptions/weather/news; "
            "if you use one, mention which source plainly, e.g. 'according to <title>'):\n" + web_context
        )
    if reasoning_paths:
        paths_text = "\n".join(f"- {p}" for p in reasoning_paths)
        context_parts.append(
            "RELATED-CONCEPT REASONING CHAINS (from the property graph — shows how mentioned "
            "concepts connect to related ones; use only if it helps directly answer the question, "
            "don't recite the chain mechanically):\n" + paths_text
        )
    if few_shot_hint:
        context_parts.append(f"MATCHED CUSTOM INTENT GUIDANCE (a human previously taught the assistant this question type; use as guidance, not verbatim):\n{few_shot_hint}")

    context = "\n\n".join(context_parts) if context_parts else "No additional context retrieved."

    system_prompt = (
        "You are a helpful, precise Indian Railways passenger assistant embedded in a website. "
        "Answer ONLY using the context provided below plus the user's question. "
        "Never invent PNR numbers, train numbers, times, statuses, train names, or classes that "
        "aren't in the context.\n\n"
        "STRICT RULES:\n"
        "- Do NOT recommend external websites, apps, or resources (e.g. IRCTC.co.in, NTES, mobile "
        "apps) unless a URL or app name literally appears in the context below - the context here "
        "never contains one, so do not suggest any.\n"
        "- Do NOT add general trivia about train types, routes, or railway history that isn't in "
        "the context, even if you know it's true - the user asked about this specific query, not "
        "for background reading.\n"
        "- If LIVE DATA LOOKUP ERROR is present, state in ONE to TWO short sentences what went "
        "wrong and what the user can do (e.g. try again shortly, or ask a policy/FAQ question "
        "instead) - do not pad this out with headers, emoji bullets, or numbered sections.\n"
        "- If the context says full detail (e.g. every stop on a route) is already shown "
        "separately to the user (a map or table), respect that: give a brief summary only, "
        "and do NOT re-list every individual item - that duplicates what's already on screen "
        "and needlessly lengthens your answer.\n"
        "- No markdown headers (#, ##). Keep formatting to plain sentences or simple '-' bullets "
        "only, and keep the whole answer under 6 short lines unless the context has a genuinely "
        "long list (e.g. a trains list) to present.\n"
        "- If LIVE WEB SEARCH RESULTS above name specific trains, numbers, or times for what was "
        "asked, PRESENT THOSE as the answer (with brief source attribution) - do not fall back to "
        "a generic 'that information isn't available, contact the helpline' answer when the web "
        "results actually contain a real answer. Only give the generic fallback when the web "
        "results genuinely don't cover the question either."
    )
    if deep_think:
        # "Deep Think" toggle: same grounding rules above still apply (no
        # inventing data), just given more room - both more retrieved
        # context (top_k was already raised to 8 by the caller) and
        # permission to actually show the reasoning instead of compressing
        # to 6 lines.
        system_prompt += (
            "\n\nDEEP THINK MODE IS ON: the user explicitly asked for thorough reasoning, so "
            "the 6-line limit above does NOT apply here. Work through the question step by "
            "step - consider the relevant angles (e.g. for a route/decision question: timing, "
            "reliability, alternatives; for a policy question: the general rule AND likely "
            "exceptions), briefly explain the reasoning, and then give a clear final answer. "
            "Still ground every factual claim in the context above - more reasoning is not "
            "permission to invent facts not present there."
        )
    if language_choice:
        system_prompt += language_support.synthesis_instruction(language_choice)
    if sentiment_result:
        system_prompt += sentiment_analysis.synthesis_tone_instruction(sentiment_result)
    user_prompt = f"User question: {question}\n\nContext:\n{context}"

    llm_answer, llm_error, _provider = _call_llm_for_synthesis(system_prompt, user_prompt)
    if llm_answer:
        return llm_answer

    fallback = _fallback_answer(question, live_data, retrieval, live_error, web_results)
    lang_note = language_support.fallback_note(language_choice) if language_choice else None
    if lang_note:
        fallback = f"{lang_note}\n\n{fallback}"

    if llm_error:
        return f"⚠️ {llm_error}\n\n(Falling back to raw retrieved info below until this is fixed.)\n\n{fallback}"

    return fallback


def _fallback_answer(question: str, live_data: dict, retrieval, live_error: str = None,
                      web_results: Optional[List["web_search.WebSearchResult"]] = None) -> str:
    # Fallback templated answer if no ANTHROPIC_API_KEY is configured.
    lines = [f"Here's what I found for: \"{question}\"\n"]
    if live_data and "trains_between_summary" in live_data:
        lines.append(live_data["trains_between_summary"])
    elif live_data:
        lines.append(f"Live data: {live_data}")
    if live_error:
        lines.append(f"⚠️ {live_error}")
    if retrieval.chunks:
        for c in retrieval.chunks:
            lines.append(f"\n• ({c.category}) {c.compressed_text}")
    if web_results:
        lines.append("\nFrom a web search:")
        for r in web_results:
            lines.append(f"\n• {r.title}: {r.snippet} ({r.url})")
    if not live_data and not live_error and not retrieval.chunks and not web_results:
        if retrieval.retrieval_performed:
            lines.append("I couldn't find anything relevant. Could you rephrase your question?")
        else:
            lines.append("Happy to help — ask me about a PNR, a train's running status, seat availability, or any railway policy question.")
    lines.append(
        "\n\n(Note: set GEMINI_API_KEY (preferred, cheaper) or ANTHROPIC_API_KEY in .env for a "
        "fully natural-language, conversational answer instead of this raw fallback view.)"
    )
    return "\n".join(lines)


def _distance_and_progress_from_route(train_info_data: Optional[dict], current_station_code: Optional[str]):
    """Derives (total_distance_km, route_progress_ratio) from an
    ALREADY-FETCHED railway_api.get_train_info() (RailKit) response and the
    train's current station code — both real, RailKit-provided figures, not
    assumptions. Reused by every delay-prediction call site (live-tracking
    WebSocket, the LIVE_STATUS chat intent, and /api/delay/predict) so the
    ML model gets the same real route-progress signal everywhere instead of
    only some paths using it and others silently falling back to defaults.
    Returns (None, None) if train_info_data wasn't available or the current
    station isn't found on the route — never a fabricated figure."""
    if not train_info_data:
        return None, None
    route = gps_tracking.parse_route(train_info_data)
    if not route:
        return None, None
    try:
        total_distance = float(route[-1].distance_km) if route[-1].distance_km else None
    except (TypeError, ValueError):
        total_distance = None

    route_progress_ratio = None
    if total_distance and current_station_code:
        stop = next((s for s in route if (s.code or "").upper() == current_station_code.upper()), None)
        if stop and stop.distance_km is not None:
            try:
                route_progress_ratio = max(0.0, min(1.0, float(stop.distance_km) / total_distance))
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    return total_distance, route_progress_ratio


def _route_distance_for_station(train_info_data: Optional[dict], station_code: Optional[str]) -> Optional[float]:
    """Real distance-from-origin for one station, read off RailKit's own
    STATIC route/schedule (train_info_data), independent of the LIVE
    timeline. Used as a fallback for gps_tracking.current_position_distance_km()
    and a stop's own distance_km when the live timeline entry for that
    station doesn't carry a distance_km itself (common for small
    intermediate points RailKit's live feed reports sparsely) - the static
    route almost always has it, since route_progress_ratio above already
    depends on exactly this figure being present for the current station.
    Returns None rather than a guess if the station isn't found on the
    route or has no real distance figure."""
    if not train_info_data or not station_code:
        return None
    route = gps_tracking.parse_route(train_info_data)
    if not route:
        return None
    stop = next((s for s in route if (s.code or "").upper() == station_code.upper()), None)
    if stop is None or stop.distance_km is None:
        return None
    try:
        return float(stop.distance_km)
    except (TypeError, ValueError):
        return None


def _resolve_avg_speed(
    train_number: str, timeline_stops: list, route_progress_ratio: Optional[float],
    distance_km: Optional[float], date_ddmmyyyy: Optional[str], time_hhmm: Optional[str],
    current_delay_minutes: Optional[int], trend_per_stop: Optional[float],
):
    """
    Shared by every call site that needs an average-speed figure
    (REST /api/delay/predict, the live-tracking WebSocket handler, and the
    per-station predictor below): combines BOTH real providers (RailKit +
    RailRadar) via gps_tracking.compute_avg_speed_multi_source, and - only
    if NEITHER provider has anything real yet (typically right after the
    train leaves origin) - falls back to delay_prediction's instant ML
    speed estimate rather than surfacing a bare dash to the user.

    Returns (avg_speed_kmph, avg_speed_basis, source) where `source` is one
    of the tags compute_avg_speed_multi_source documents, or "ml_estimate".
    """
    rr_stops = []
    live_speed, live_speed_note = None, None
    try:
        rr_stops = railradar_fallback.fetch_railradar_timeline(train_number, date_ddmmyyyy)
    except Exception:
        rr_stops = []
    try:
        live_speed, live_speed_note = railradar_fallback.get_live_speed_kmph(train_number)
    except Exception:
        live_speed, live_speed_note = None, None

    speed, note, source = gps_tracking.compute_avg_speed_multi_source(
        timeline_stops, rr_stops, live_speed_kmph=live_speed, live_speed_note=live_speed_note,
    )
    if speed is not None:
        return speed, note, source

    try:
        estimate = delay_prediction.estimate_avg_speed_kmph_ml(
            distance_km=distance_km, route_progress_ratio=route_progress_ratio,
            time_hhmm=time_hhmm, date_ddmmyyyy=date_ddmmyyyy,
            current_delay_minutes=current_delay_minutes, recent_delay_trend_per_stop=trend_per_stop,
        )
        note = f"[ML instant estimate, {estimate.confidence} confidence] {estimate.basis}"
        return estimate.speed_kmph, note, "ml_estimate"
    except Exception:
        return None, note, source


def _match_station_in_timeline(timeline_json: list, label: Optional[str]) -> Optional[dict]:
    """
    FEATURE: label-aware delay alerts — resolves a watch's free-text
    `label` (e.g. "Vijayawada", "BZA") against this train's REAL live
    timeline (every reporting halt AND intermediate point RailKit reports
    for this run), so a watch can be tied to an actual station on this
    train's actual route instead of just being a display string.

    Matches by exact station CODE first (case/whitespace-insensitive —
    e.g. "bza"), then by a punctuation/case-insensitive substring match on
    station NAME either direction (RailKit names are inconsistent, e.g.
    "SECUNDERABAD JN" vs a person typing "Secunderabad" or "Secunderabad
    Junction") — real timeline data only, never a guessed/fabricated
    match. Returns None if nothing on this run's route matches, which
    callers treat as "this label isn't a real station on this train" and
    skip notifying rather than showing a meaningless prediction.
    """
    def _norm(text: str) -> str:
        # Strip punctuation/whitespace, then fold the handful of station-
        # suffix abbreviations RailKit and everyday typing disagree on
        # (e.g. "Secunderabad Junction" vs RailKit's "SECUNDERABAD JN") so
        # a plain substring check still matches instead of missing on the
        # abbreviation alone.
        t = re.sub(r"[^A-Z0-9]", "", text.upper())
        for full, short in (("JUNCTION", "JN"), ("CANTONMENT", "CANTT"), ("TERMINUS", "T")):
            t = t.replace(full, short)
        return t

    if not label or not timeline_json:
        return None
    norm_label = _norm(label)
    if not norm_label:
        return None
    for stop in timeline_json:
        code = stop.get("code") or ""
        if code and _norm(code) == norm_label:
            return stop
    for stop in timeline_json:
        name = stop.get("name") or ""
        norm_name = _norm(name)
        if norm_name and (norm_label in norm_name or norm_name in norm_label):
            return stop
    return None


def _fetch_timeline_with_predictions(train_number: str, date: Optional[str], travel_class: Optional[str] = None):
    """
    FEATURE: Connection-Risk Alert support. Fetches ONE train's real live
    timeline with the same per-station predicted-delay mutation
    _predict_for_watch_station already applies for its own single-target
    use — duplicated here on purpose rather than shared: _predict_for_watch_station
    is the delay-alerts/push pipeline and has been the subject of many
    hard-won bugfixes documented throughout this file's history, so this is
    a fresh, additive read path that must never risk changing that one's
    behavior. A caller that needs the FULL timeline_json for TWO different
    stations/trains (like connection-risk, comparing an interchange station
    across two different trains' routes) can't use _predict_for_watch_station's
    single-station-only contract, hence this.

    Returns (timeline_json, position) — (None, None) if live data isn't
    available for this train right now, (timeline_json_possibly_empty, position)
    otherwise so a caller can still show what IS known (e.g. current position)
    even with an empty/short timeline.
    """
    try:
        live_data = railway_api.get_live_train_status(train_number, date)
    except railway_api.RailwayAPIError:
        return None, None
    train_info_data = None
    try:
        train_info_data = railway_api.get_train_info(train_number)
    except railway_api.RailwayAPIError:
        pass

    position = gps_tracking.parse_live_position(train_number, live_data, train_info_data)
    timeline_stops = gps_tracking.parse_full_timeline(live_data, train_info_data)
    timeline_json = gps_tracking.timeline_to_json(timeline_stops)
    if not timeline_json:
        return timeline_json, position

    trend = gps_tracking.compute_recent_delay_trend(timeline_stops)
    current_delay_minutes = position.delay_minutes if position else None
    reference_station = position.current_station_code if position else None
    total_distance_km, route_progress_ratio = _distance_and_progress_from_route(train_info_data, reference_station)
    avg_speed_kmph, avg_speed_basis, _src = _resolve_avg_speed(
        train_number, timeline_stops, route_progress_ratio, total_distance_km,
        date, None, current_delay_minutes, trend.get("trend_per_stop"),
    )
    try:
        rr_stops = railradar_fallback.fetch_railradar_timeline(train_number, date)
    except Exception:
        rr_stops = []
    _predict_delay_per_reporting_station(
        timeline_json, total_distance_km, current_delay_minutes,
        trend.get("trend_per_stop"), trend.get("basis"),
        avg_speed_kmph, avg_speed_basis, date, travel_class,
        train_info_data=train_info_data, rr_stops=rr_stops,
    )
    return timeline_json, position


def _predict_for_watch_station(train_number: str, date: Optional[str], label: Optional[str] = None,
                                travel_class: Optional[str] = None) -> dict:
    """
    FEATURE: label-aware delay-alert lookup — the single source of truth
    for both push notifications (alert_scheduler.py, via the
    _predict_delay_for_watch closure in this file's startup handler) AND
    the in-app /api/advanced/alerts/check batch endpoint, so the two never
    diverge (same "one prediction pipeline, multiple trigger paths"
    pattern as the rest of the delay-prediction code in this file).

    Three real, live-data-driven outcomes:
      - "not_on_route": `label` doesn't match any real station on this
        train's actual live timeline for this run — no notification
        should fire for a watch like this (an invalid/mistyped label),
        so callers skip it entirely rather than predicting nonsense.
      - "already_reached": the labelled station's live status is
        "current" or "passed" — the train has already been there, so a
        delay PREDICTION would be meaningless. Returns the real recorded
        arrival clock time instead (actual, falling back to expected then
        scheduled if RailKit hasn't recorded a real actual time), so the
        caller can say "this station is already reached at HH:MM".
      - "predicted": the labelled station is still "upcoming" — returns a
        live-data-grounded predicted delay for THAT SPECIFIC station (via
        _predict_delay_per_reporting_station, the same per-station
        pipeline the Live Tracking tab itself uses), not just a generic
        "next station" figure.
    With no `label` at all, falls back to predicting for the very next
    upcoming reporting station — the exact behavior this always had before
    labels became station-aware, so existing watches with a non-station
    free-text label keep working unchanged.
    """
    try:
        live_data = railway_api.get_live_train_status(train_number, date)
    except railway_api.RailwayAPIError as e:
        return {"status": "unavailable", "delay_minutes": None, "station": None,
                "message": f"Live status unavailable for train {train_number}: {e}"}

    train_info_data = None
    try:
        train_info_data = railway_api.get_train_info(train_number)
    except railway_api.RailwayAPIError:
        pass

    position = gps_tracking.parse_live_position(train_number, live_data, train_info_data)
    timeline_stops = gps_tracking.parse_full_timeline(live_data, train_info_data)
    timeline_json = gps_tracking.timeline_to_json(timeline_stops)
    if not timeline_json:
        return {"status": "unavailable", "delay_minutes": None, "station": None,
                "message": f"No live timeline available yet for train {train_number}."}

    matched = _match_station_in_timeline(timeline_json, label) if label else None
    if label and matched is None:
        return {"status": "not_on_route", "delay_minutes": None, "station": None,
                "message": f"\"{label}\" isn't a station on train {train_number}'s route — no alert set up for it."}

    if matched is not None and matched.get("status") in ("current", "passed"):
        timing = matched.get("arrival") or {}
        actual_time = timing.get("actual") or timing.get("expected") or timing.get("scheduled")
        return {
            "status": "already_reached", "delay_minutes": timing.get("delay_minutes"),
            "station": matched.get("name"), "actual_time": actual_time,
            "message": (
                f"{matched.get('name')} is already reached"
                + (f" (at {actual_time})" if actual_time else "") + "."
            ),
        }

    trend = gps_tracking.compute_recent_delay_trend(timeline_stops)
    current_delay_minutes = position.delay_minutes if position else None
    reference_station = position.current_station_code if position else None
    total_distance_km, route_progress_ratio = _distance_and_progress_from_route(train_info_data, reference_station)
    avg_speed_kmph, avg_speed_basis, _src = _resolve_avg_speed(
        train_number, timeline_stops, route_progress_ratio, total_distance_km,
        date, None, current_delay_minutes, trend.get("trend_per_stop"),
    )
    try:
        rr_stops = railradar_fallback.fetch_railradar_timeline(train_number, date)
    except Exception:
        rr_stops = []
    _predict_delay_per_reporting_station(
        timeline_json, total_distance_km, current_delay_minutes,
        trend.get("trend_per_stop"), trend.get("basis"),
        avg_speed_kmph, avg_speed_basis, date, travel_class,
        train_info_data=train_info_data, rr_stops=rr_stops,
    )

    target = matched
    if target is None:
        target = next(
            (s for s in timeline_json if s.get("status") == "upcoming" and s.get("kind") != "intermediate"),
            None,
        )
    if target is None or target.get("predicted_delay_minutes") is None:
        return {"status": "unavailable", "delay_minutes": None, "station": target.get("name") if target else None,
                "message": f"No upcoming reporting station left to predict for train {train_number}."}

    return {
        "status": "predicted",
        "delay_minutes": target.get("predicted_delay_minutes"),
        "confidence": target.get("predicted_delay_confidence"),
        "station": target.get("name"),
        "predicted_eta": target.get("predicted_eta"),
        "current_station": position.current_station_name if position else None,
        "message": f"{target.get('name')} is predicted ~{target.get('predicted_delay_minutes')} min late.",
    }


def _predict_delay_per_reporting_station(
    timeline_json: list, total_distance_km, current_delay_minutes,
    trend_per_stop, trend_basis, avg_speed_kmph, avg_speed_basis,
    date_ddmmyyyy, travel_class, eta_speed_kmph=None, train_info_data=None,
    weather_component_minutes: float = 0.0, rr_stops: Optional[list] = None,
) -> None:
    """
    FEATURE: per-station predicted delay for every upcoming REPORTING
    station (RailYatri-style — genuine scheduled halts only, kind !=
    "intermediate"). Mutates `timeline_json` IN PLACE, adding
    `predicted_delay_minutes` / `predicted_delay_confidence` / `predicted_eta`
    onto every reporting station whose `status` is "upcoming" (the
    currently-occupied station and already-passed ones are left alone —
    they carry RailKit's own REAL recorded/live delay already, which must
    never be overwritten by a model estimate). Small intermediate points
    (signalling cabins, passing loops — anything RailKit doesn't mark as a
    real halt) still get a real-time `predicted_eta`/`distance_ahead_km` for
    context, but no `predicted_delay_minutes` figure — see the "PREDICTED
    DELAY IS REPORTING-STOPS-ONLY" note in the loop below for why.

    HONEST NOTE: an earlier version of this function called the
    single-shot ML ensemble once per station with only `route_progress_ratio`
    varying between calls. Two stations a few km apart barely move that
    ratio, so — with every OTHER feature (current delay, trend, avg speed)
    held constant across the whole list — the ensemble rounded to the exact
    SAME predicted minutes for every future station, which is wrong: it
    looked like one static number copy-pasted down the list instead of a
    real per-station forecast.

    This version fixes that by blending the ML ensemble's estimate with a
    real, station-specific extrapolation built directly from RailKit data:
      - `trend_component`: the real recent per-stop delay trend (from
        compute_recent_delay_trend, i.e. actual crossed-station delays),
        applied once per real REPORTING stop between the train's current
        position and THIS station (non-reporting points don't get their own
        trend step — the trend is a halt-to-halt figure — but they still
        inherit whatever trend has accumulated over the reporting stops
        already behind them), damped geometrically (0.7 per stop) so a
        worsening trend doesn't compound to an absurd number many stops out.
      - `speed_component`: real extra minutes lost between here and THIS
        specific station, computed from the real remaining distance
        (RailKit's own distance_km, falling back to RailKit's static route
        distance via `_route_distance_for_station` when the live timeline
        entry doesn't carry one — small intermediate points often don't) at
        the real current average running speed vs. the typical scheduled
        express speed.
    Both components are anchored to that station's own real distance from
    the train's current position, so they naturally differ station to
    station — including between two intermediate points a few km apart.
    """
    current_delay_minutes = current_delay_minutes if current_delay_minutes is not None else 0
    trend = trend_per_stop if trend_per_stop is not None else 0.0
    typical_speed = getattr(delay_prediction, "_TYPICAL_EXPRESS_SPEED_KMPH", 55.0)

    # FEATURE: use RailRadar's own REAL recorded arrival/departure for an
    # "upcoming" station whenever it has one, instead of always falling
    # through to this app's own ML/heuristic prediction. RailKit sometimes
    # leaves a station's status stuck on "upcoming" long after the train
    # has genuinely passed it (see the frontend's journeyLikelyComplete
    # fallback), even though RailRadar independently marks that same stop
    # "departed" with a real actualArrival/actualDeparture timestamp and
    # its own real delayArrival/delayDeparture — a second, independently
    # reporting provider, not a guess. rr_stops is fetched once per poll
    # by the caller (see ws_track_train) and passed in here; matched by
    # station CODE only (RailKit and RailRadar station names can differ
    # slightly). A RailRadar entry only counts as real confirmation when
    # its OWN status is "passed" (i.e. raw "departed") — an "upcoming"
    # RailRadar entry is just as unconfirmed as RailKit's.
    rr_by_code = {}
    for rr in (rr_stops or []):
        code = (getattr(rr, "code", None) or "").strip().upper()
        if code and getattr(rr, "status", None) == "passed":
            rr_by_code[code] = rr

    def _stop_distance_km(stop):
        d = gps_tracking._distance_km_value(stop.get("distance_km"))
        if d is None:
            d = _route_distance_for_station(train_info_data, stop.get("code"))
        return d

    # Real current-position distance (RailKit's own distance_km on the
    # "current" stop, or the last "passed" reporting station if the train
    # is running between two stops), with the same static-route fallback —
    # the anchor every future station's real remaining distance is measured
    # from.
    current_distance_km = None
    current_entry = next((s for s in timeline_json if s.get("status") == "current"), None)
    if current_entry is None:
        passed = [s for s in timeline_json if s.get("kind") != "intermediate" and s.get("status") == "passed"]
        current_entry = passed[-1] if passed else None
    if current_entry is not None:
        current_distance_km = _stop_distance_km(current_entry)

    stops_ahead = 0          # counts every upcoming station (halt or not) — used for confidence widening
    reporting_stops_ahead = 0  # counts only real reporting halts — used for the trend extrapolation
    for stop in timeline_json:
        if stop.get("status") != "upcoming":
            continue
        stops_ahead += 1
        is_reporting = stop.get("kind") != "intermediate"
        if is_reporting:
            reporting_stops_ahead += 1

        stop_distance = _stop_distance_km(stop)
        distance_ahead_km = None
        if stop_distance is not None and current_distance_km is not None:
            distance_ahead_km = max(0.0, stop_distance - current_distance_km)

        # PREDICTED DELAY IS REPORTING-STOPS-ONLY: a small intermediate point
        # (a signalling cabin, a passing loop — never a scheduled halt) still
        # gets its real-time ETA/distance below, but no predicted_delay_minutes
        # figure. This was previously computed for every upcoming point
        # (reporting and intermediate alike), which could surface a badly
        # inflated number at a real reporting station — e.g. VSKP showing a
        # 42-min ML/heuristic-blended estimate while the actual real-time ETA
        # math implied only ~13 min — because the same blended figure was
        # being asked to serve both intermediate filler points and genuine
        # reporting halts under one formula. Scoping this to reporting halts
        # only keeps the number meaningful for the stops it's actually shown
        # for in the Live Tracking tab (web and mobile both read this same
        # backend field, so this fix covers both automatically).
        if not is_reporting:
            eta_speed = eta_speed_kmph or avg_speed_kmph
            stop["predicted_eta"] = gps_tracking.compute_live_eta(distance_ahead_km, eta_speed)
            stop["distance_ahead_km"] = round(distance_ahead_km, 1) if distance_ahead_km is not None else None
            continue

        route_progress_ratio = None
        if stop_distance is not None and total_distance_km:
            try:
                route_progress_ratio = max(0.0, min(1.0, stop_distance / float(total_distance_km)))
            except (TypeError, ValueError, ZeroDivisionError):
                route_progress_ratio = None

        try:
            ml_pred = delay_prediction.predict_delay(
                distance_km=total_distance_km, date_ddmmyyyy=date_ddmmyyyy,
                route_progress_ratio=route_progress_ratio, current_delay_minutes=current_delay_minutes,
                travel_class=travel_class, recent_delay_trend_per_stop=trend_per_stop,
                recent_delay_basis=trend_basis, avg_speed_kmph=avg_speed_kmph, avg_speed_basis=avg_speed_basis,
            )
            ml_minutes = ml_pred.predicted_delay_minutes
            confidence = ml_pred.confidence
        except Exception:
            ml_minutes = None
            confidence = "Low"

        trend_component = sum(trend * (0.7 ** k) for k in range(reporting_stops_ahead))
        speed_component = 0.0
        if avg_speed_kmph and avg_speed_kmph > 0 and distance_ahead_km:
            time_now_min = distance_ahead_km / avg_speed_kmph * 60.0
            time_typical_min = distance_ahead_km / typical_speed * 60.0
            speed_component = max(0.0, time_now_min - time_typical_min)
        # Real weather reading at the train's CURRENT position, damped per
        # station-ahead (0.85/stop) since it's read at one point and fog/
        # rain patches move and dissipate — a plausible proxy for the very
        # next few stations, progressively less so many stops out.
        weather_component = weather_component_minutes * (0.85 ** (stops_ahead - 1)) if weather_component_minutes else 0.0

        heuristic_minutes = max(0.0, min(400.0, current_delay_minutes + trend_component + speed_component + weather_component))
        blended = round(0.65 * heuristic_minutes + 0.35 * (ml_minutes if ml_minutes is not None else heuristic_minutes))
        blended = max(0, blended)
        stop["predicted_delay_minutes"] = blended
        stop["predicted_delay_confidence"] = confidence
        # Confidence band, widening further out for stations we have less
        # certainty about (each stop ahead compounds the trend/speed
        # extrapolation) - same tiered spread as the single-figure
        # prediction (delay_prediction._confidence_band), with a small
        # extra widening per station-ahead layered on top.
        low, high = delay_prediction._confidence_band(blended, confidence)
        extra = round(blended * 0.03 * (stops_ahead - 1))  # +3%/station further out, first station unaffected
        stop["predicted_delay_low_minutes"] = max(0, low - extra)
        stop["predicted_delay_high_minutes"] = high + extra

        # FEATURE: ETA recalculated every GPS ping (see
        # gps_tracking.compute_live_eta), using the freshest real speed
        # reading (recency-weighted instant speed when available, real
        # avg speed otherwise) rather than waiting on RailKit's own
        # `expected` field, which only refreshes when a halt is crossed.
        # Same station-specific distance_ahead_km as above, so a non-halt
        # point 8 km up the line gets its own ETA, not the next halt's.
        eta_speed = eta_speed_kmph or avg_speed_kmph
        stop["predicted_eta"] = gps_tracking.compute_live_eta(distance_ahead_km, eta_speed)
        stop["distance_ahead_km"] = round(distance_ahead_km, 1) if distance_ahead_km is not None else None

        # BUGFIX: predicted_delay_minutes and predicted_eta were computed
        # by two INDEPENDENT methods that can badly disagree — e.g. WARANGAL
        # showing "~11 (6-16) min late... ETA ~18:26" while Exp was 16:35:
        # 18:26 is genuinely 111 minutes past 16:35, not 11. The heuristic
        # above (current_delay_minutes + trend + speed + weather) can
        # understate reality whenever RailKit's own `current_delay_minutes`
        # is 0/unknown at that moment, even though predicted_eta — grounded
        # in the ACTUAL current wall-clock time plus real remaining
        # distance/speed — already implies a much bigger gap. predicted_eta
        # is the harder-to-fool number (it's just arithmetic on real
        # inputs), so it's now the source of truth: whenever we can compare
        # it against this station's own real expected/scheduled time, THAT
        # difference becomes predicted_delay_minutes, replacing the
        # heuristic's guess rather than living alongside it. The heuristic
        # remains the fallback only when expected/predicted_eta aren't
        # both available to compare.
        grounded_delay = None
        expected_str = (stop.get("arrival") or {}).get("expected") or (stop.get("arrival") or {}).get("scheduled")
        exp_min = gps_tracking._time_str_to_minutes(expected_str)
        eta_min = gps_tracking._time_str_to_minutes(stop["predicted_eta"])
        if exp_min is not None and eta_min is not None:
            diff = eta_min - exp_min
            # BUGFIX: this used a blanket "diff < -60 => must be a midnight
            # rollover" rule, which wrongly fired for a station like VSKP
            # where predicted_eta (21:45) was genuinely, plainly earlier
            # than expected (23:35) on the SAME day - a real 110-minute
            # early running margin (common at big junction stations with
            # generous schedule padding), not a day-boundary crossing. The
            # old rule added a full 1440 min to that, turning a perfectly
            # normal "running early" into a nonsensical "+400m late" (the
            # 400 ceiling below), red-badged, while visually-identical
            # on-time neighbour stations showed green ~0m - exactly the
            # inconsistency reported against a real running instance of
            # train 20834. A predicted_eta/expected pair only ACTUALLY
            # straddles midnight when expected is late night and the
            # predicted time is early morning - i.e. the two clock times
            # are more than 12h apart, the standard circular-time-diff
            # test - not merely "more than an hour apart". Genuinely early
            # running (diff negative, within 12h) is a real, honest signal
            # that the train is ahead of schedule, so it's floored to 0
            # (not a negative delay) by the existing max(0, ...) below,
            # never inflated into a fake "late" figure.
            if diff < -720:
                diff += 1440
            elif diff > 720:
                diff -= 1440
            grounded_delay = max(0, min(400, round(diff)))

        if grounded_delay is not None:
            blended = grounded_delay
            stop["predicted_delay_minutes"] = blended
            low, high = delay_prediction._confidence_band(blended, confidence)
            extra = round(blended * 0.03 * (stops_ahead - 1))
            stop["predicted_delay_low_minutes"] = max(0, low - extra)
            stop["predicted_delay_high_minutes"] = high + extra
        # Tracks whether THIS station's own real schedule could be checked
        # against reality (grounded) vs falling back to the heuristic guess
        # - read by the neighbor-consistency pass right after this loop,
        # and by the arrival/departure reconciliation pass further below.
        stop["predicted_delay_is_grounded"] = grounded_delay is not None
        stop["_stops_ahead"] = stops_ahead  # internal only - used for the confidence-band recompute after any consistency adjustment

        # FEATURE: cross-method agreement as a real confidence signal.
        # Request was to surface which predictions most closely MATCH other
        # apps' delay estimates - there's no public API for RailYatri or
        # similar apps to pull a live number from (confirmed separately),
        # so this uses the closest honest alternative available: how
        # closely THIS station's delay comes out across genuinely
        # INDEPENDENT methods already computed above - the ML ensemble's
        # own estimate (ml_minutes), the heuristic trend/speed/weather
        # blend (heuristic_minutes), and the real actual-vs-expected
        # arithmetic (grounded_delay). These don't share the same inputs,
        # so when they converge closely, that's a genuine signal the
        # prediction is trustworthy - not the same number restated three
        # ways. When they disagree substantially, confidence is honestly
        # downgraded rather than papered over.
        candidates = [v for v in (ml_minutes, heuristic_minutes, grounded_delay) if v is not None]
        agreement_spread = round(max(candidates) - min(candidates), 1) if len(candidates) >= 2 else None
        stop["prediction_agreement_minutes"] = agreement_spread
        stop["prediction_methods_compared"] = len(candidates)
        if agreement_spread is not None:
            tiers = ["Low", "Moderate", "High", "Very High"]
            tier_idx = tiers.index(confidence) if confidence in tiers else 1
            if agreement_spread <= 3:
                tier_idx = min(len(tiers) - 1, tier_idx + 1)  # methods agree closely -> upgrade
            elif agreement_spread > 12:
                tier_idx = max(0, tier_idx - 1)  # methods meaningfully disagree -> be honest, downgrade
            confidence = tiers[tier_idx]
        stop["predicted_delay_confidence"] = confidence
        # Recompute the band around whatever the FINAL predicted_delay_minutes
        # is (grounded_delay if available, else the original blended value)
        # using the possibly-adjusted confidence tier, so the band width
        # reflects the same trust level shown in the label.
        low, high = delay_prediction._confidence_band(stop["predicted_delay_minutes"], confidence)
        extra = round(stop["predicted_delay_minutes"] * 0.03 * (stops_ahead - 1))
        stop["predicted_delay_low_minutes"] = max(0, low - extra)
        stop["predicted_delay_high_minutes"] = high + extra

    # FEATURE: neighbor-consistency pass. A station without its own real
    # schedule (common for signalling cabins / small halts RailKit's
    # timetable doesn't carry a time for - e.g. "F Cabin" points) falls
    # back to the heuristic guess above, which has repeatedly proven to
    # UNDERSTATE reality compared to the grounded (real actual-vs-expected)
    # figure whenever this project has caught the two disagreeing. Real
    # case that motivated this: KAZIPET F CABIN (135.2 km) showed "+7 min"
    # from the heuristic while WARANGAL (142 km, just 6.8 km further)
    # showed a REAL, schedule-grounded "+38 min" - a 31-minute jump over
    # under 7 km isn't physically plausible at any realistic train speed,
    # so the heuristic figure was almost certainly the wrong one.
    #
    # This raises (never lowers) a heuristic-only station's predicted
    # delay to stay physically consistent with the NEAREST grounded
    # neighbor, allowing a generous 1 min/km of genuine recovery margin
    # over the real distance between them (so a station a long way from
    # any grounded anchor, or one where real recovery is plausible, isn't
    # forced to match) - only applied within 25 km of a grounded anchor,
    # since beyond that the physical-implausibility argument stops holding.
    MAX_PLAUSIBLE_RECOVERY_PER_KM = 1.0
    NEIGHBOR_CONSISTENCY_RADIUS_KM = 25.0
    upcoming = [s for s in timeline_json if s.get("status") == "upcoming" and s.get("predicted_delay_minutes") is not None]
    grounded_neighbors = [s for s in upcoming if s.get("predicted_delay_is_grounded") and s.get("distance_ahead_km") is not None]
    if grounded_neighbors:
        for s in upcoming:
            if s.get("predicted_delay_is_grounded") or s.get("distance_ahead_km") is None:
                continue
            nearest = min(grounded_neighbors, key=lambda g: abs(g["distance_ahead_km"] - s["distance_ahead_km"]))
            gap_km = abs(nearest["distance_ahead_km"] - s["distance_ahead_km"])
            if gap_km > NEIGHBOR_CONSISTENCY_RADIUS_KM:
                continue
            floor = max(0, round(nearest["predicted_delay_minutes"] - gap_km * MAX_PLAUSIBLE_RECOVERY_PER_KM))
            if floor > s["predicted_delay_minutes"]:
                s["predicted_delay_minutes"] = floor
                s["predicted_delay_consistency_adjusted"] = True
                s["predicted_delay_consistency_note"] = (
                    f"raised from a heuristic estimate to stay physically consistent with "
                    f"{nearest.get('name', 'a nearby station')}'s real schedule-grounded delay, "
                    f"{round(gap_km, 1)} km away"
                )
                low, high = delay_prediction._confidence_band(floor, s.get("predicted_delay_confidence") or "Moderate")
                extra = round(floor * 0.03 * (s.get("_stops_ahead", 1) - 1))
                s["predicted_delay_low_minutes"] = max(0, low - extra)
                s["predicted_delay_high_minutes"] = high + extra

    # BUGFIX: reconcile the per-station Exp/Act row with the FINAL
    # predicted_delay_minutes/predicted_eta above (post neighbor-consistency
    # adjustment, if any applied) - for UPCOMING stations only. Before this,
    # `stop["arrival"]["actual"]` and `["delay_minutes"]` came straight from
    # RailKit's own raw timeline fields untouched — RailKit does supply a
    # predicted arrival/delay for stations the train hasn't reached yet,
    # but it updates on its own schedule and disagreed with this function's
    # own differentiated prediction (e.g. RailKit showing an identical flat
    # +69 min gap at two different stations while this function showed
    # differentiated 13 min / 23 min for the same two stations — two
    # unreconciled numbers on the same screen for the same thing).
    # Passed/current stations are NEVER touched here — those carry RailKit's
    # own REAL recorded arrival/departure, which must stay exactly as
    # reported. Runs as its OWN pass (not inline in the main loop above) so
    # it always reads each station's truly final predicted_delay_minutes,
    # including anything the neighbor-consistency pass just adjusted.
    for stop in timeline_json:
        if stop.get("status") != "upcoming" or not stop.get("predicted_eta"):
            continue
        final_delay = stop.get("predicted_delay_minutes")
        if final_delay is None:
            continue
        rr_stop = rr_by_code.get((stop.get("code") or "").strip().upper())
        for event_key, extra_minutes in (("arrival", 0), ("departure", stop.get("halt_minutes") or 0)):
            event = stop.get(event_key)
            if not isinstance(event, dict):
                continue
            # FEATURE: RailRadar's own REAL recorded time for this exact
            # event, when it has one (see rr_by_code above) — takes
            # priority over our own model's prediction below, since it's
            # an actually-recorded value from a second live provider, not
            # an estimate. RailRadar's own delay_minutes is used directly
            # when present; otherwise it's derived from RailRadar's real
            # actual vs THIS event's own expected/scheduled time, same
            # day-rollover-safe arithmetic as the predicted path below.
            rr_event = getattr(rr_stop, event_key, None) if rr_stop is not None else None
            rr_actual = getattr(rr_event, "actual", None) if rr_event is not None else None
            if rr_actual:
                event["actual"] = rr_actual
                rr_delay = getattr(rr_event, "delay_minutes", None)
                if rr_delay is not None:
                    event["delay_minutes"] = rr_delay
                else:
                    rr_anchor = event.get("expected") or event.get("scheduled")
                    rr_anchor_min = gps_tracking._time_str_to_minutes(rr_anchor)
                    rr_actual_min = gps_tracking._time_str_to_minutes(rr_actual)
                    if rr_anchor_min is not None and rr_actual_min is not None:
                        rr_diff = rr_actual_min - rr_anchor_min
                        if rr_diff < -720:
                            rr_diff += 1440
                        elif rr_diff > 720:
                            rr_diff -= 1440
                        event["delay_minutes"] = max(0, min(400, round(rr_diff)))
                event["actual_is_predicted"] = False
                event["actual_source"] = "railradar"
                continue
            try:
                extra = int(extra_minutes)
            except (TypeError, ValueError):
                extra = 0
            if extra:
                eta_dt = datetime.strptime(stop["predicted_eta"], "%H:%M") + timedelta(minutes=extra)
                event["actual"] = eta_dt.strftime("%H:%M")
            else:
                event["actual"] = stop["predicted_eta"]
            # BUGFIX: this used to assign the SAME arrival-anchored delay to
            # both arrival AND departure regardless of each event's own
            # expected time — e.g. Vijayawada showing Departure "Exp 09:45 /
            # Act 09:52 / +12m", where 09:52 minus 09:45 is genuinely 7
            # minutes, not 12 (the +12 was arrival's own 09:52-09:40 gap,
            # copied onto departure verbatim whenever halt_minutes wasn't
            # available to offset departure's own predicted actual). Each
            # event's delay_minutes must come from THAT event's own
            # (actual - expected/scheduled) arithmetic, never borrowed from
            # a different event's gap.
            own_anchor = event.get("expected") or event.get("scheduled")
            own_anchor_min = gps_tracking._time_str_to_minutes(own_anchor)
            own_actual_min = gps_tracking._time_str_to_minutes(event["actual"])
            if own_anchor_min is not None and own_actual_min is not None:
                own_diff = own_actual_min - own_anchor_min
                # BUGFIX: same fix as the grounded_delay midnight-rollover
                # check above - a >12h gap is what actually indicates a real
                # day-boundary crossing; a smaller negative diff just means
                # this event's predicted actual is genuinely earlier than
                # its own expected/scheduled time on the same day (running
                # early), which max(0, ...) below correctly floors to 0
                # instead of the old code inflating it into a fake "+400m
                # late" badge.
                if own_diff < -720:
                    own_diff += 1440
                elif own_diff > 720:
                    own_diff -= 1440
                event["delay_minutes"] = max(0, min(400, round(own_diff)))
            else:
                event["delay_minutes"] = final_delay
            event["actual_is_predicted"] = True  # tells the frontend this is OUR model's estimate, not RailKit's own recorded value


def _find_stop(route, code):
    if not code:
        return None
    upper = code.upper()
    return next((s for s in route if (s.code or "").upper() == upper), None)


def _answer_station_query(route, train_number: str, source_code, dest_code) -> Optional[str]:
    """Directly answers a specific-station(s) question ('arrival time from SC
    to KMT', 'when does it reach KMT') straight from the already-fetched
    route data - no LLM involved, so the times/distance can't be
    misread or paraphrased incorrectly. Returns None if neither source_code
    nor dest_code was actually given (i.e. this isn't that kind of query)."""
    if not source_code and not dest_code:
        return None

    src_stop = _find_stop(route, source_code)
    dst_stop = _find_stop(route, dest_code)

    if source_code and dest_code:
        missing = [c for c, s in ((source_code, src_stop), (dest_code, dst_stop)) if not s]
        if missing:
            return (
                f"{' and '.join(missing)} not found on train {train_number}'s actual route - "
                "please double-check the station code(s)."
            )
        dist = None
        if src_stop.distance_km is not None and dst_stop.distance_km is not None:
            try:
                dist = round(float(dst_stop.distance_km) - float(src_stop.distance_km), 1)
            except (TypeError, ValueError):
                dist = None
        dist_note = f", covering {dist} km on this stretch" if dist is not None else ""
        return (
            f"Train {train_number} departs {src_stop.name} ({src_stop.code}) at "
            f"{src_stop.scheduled_departure or 'an unlisted time'} and arrives at "
            f"{dst_stop.name} ({dst_stop.code}) at {dst_stop.scheduled_arrival or 'an unlisted time'}"
            f"{dist_note}."
        )

    # Only one station given — report both its arrival and departure.
    code, stop = (source_code, src_stop) if source_code else (dest_code, dst_stop)
    if not stop:
        return f"{code} not found on train {train_number}'s actual route - please double-check the station code."
    return (
        f"Train {train_number} arrives at {stop.name} ({stop.code}) at "
        f"{stop.scheduled_arrival or 'an unlisted time'} and departs at "
        f"{stop.scheduled_departure or 'an unlisted time'}."
    )


_UPTO_RE = re.compile(r"\b(?:up\s?to|until|till|before)\b\s+(.+)", re.IGNORECASE)


def _extract_upto_station(question: str):
    """Detects an 'upto <station>' / 'until <station>' / 'till <station>' /
    'before <station>' phrase and resolves it to a station code, reusing
    query_router's own extraction so this understands both explicit codes
    ('BZA') and everyday city names ('Vijayawada') exactly the same way the
    rest of the router does. Returns a station code, or None if no such
    phrase is present or it doesn't resolve to a known station."""
    match = _UPTO_RE.search(question)
    if not match:
        return None
    # Limit to a short phrase so trailing clauses ("...in the form a list")
    # don't get pulled into station matching.
    tail = " ".join(match.group(1).split()[:4])
    codes = query_router._extract_stations(tail)
    return codes[0] if codes else None


def _truncate_route_upto(route, station_code: str):
    """Returns the prefix of `route` up to and including the first stop
    matching station_code (case-insensitive). If the code isn't found in
    this train's actual route, returns None so the caller can fall back to
    the full route with an honest note rather than silently ignoring the
    request or fabricating a cutoff point."""
    upper = station_code.upper()
    for i, stop in enumerate(route):
        if (stop.code or "").upper() == upper:
            return route[: i + 1]
    return None


_FULL_LIST_PHRASES = [
    "all stops", "every stop", "each stop", "full list", "complete list",
    "list all", "in the form a list", "in list form", "as a list",
    "full schedule", "detailed schedule", "list format", "list of stops",
    "list of stations", "all stations", "every station",
]


def _wants_full_stop_list(question: str) -> bool:
    """True if the user's phrasing explicitly asks for the full stop-by-stop
    list, rather than the default brief summary. Kept as simple keyword
    matching (same style as query_router.py) rather than another LLM call -
    this is a binary, structurally distinctive signal, not something that
    benefits from a model's judgement."""
    q = question.lower()
    return any(phrase in q for phrase in _FULL_LIST_PHRASES)


def _format_full_stop_list(route, train_number: str) -> str:
    """Renders every stop as plain text, straight from already-fetched route
    data - no LLM involved, so there's no token-limit or cost concern even
    for a train with 40+ stops, and the numbers can't drift from what the
    map/table above already shows since it's the exact same `route` list."""
    if not route:
        return f"No stop data available for train {train_number}."
    lines = [f"Full stop list for train {train_number}:"]
    for s in route:
        arr = s.scheduled_arrival or "—"
        dep = s.scheduled_departure or "—"
        dist = f", {s.distance_km} km" if s.distance_km else ""
        lines.append(f"- {s.name} ({s.code}): Arrives {arr}, Departs {dep}{dist}")
    return "\n".join(lines)


@app.post("/api/chat")
def chat(req: ChatRequest):
    question = req.message.strip()

    try:
        # Live-tracking context: if the mobile app told us which train is
        # already on screen and the typed question doesn't already mention
        # a 5-digit train number itself, prepend it so query_router picks
        # it up as an entity exactly like it would from typed text.
        if req.train_number and question and not query_router.TRAIN_NO_RE.search(question):
            question = f"Train {req.train_number.strip()}: {question}"

        image_note = None
        # --- Multi-Modal RAG: read an attached ticket photo, if any ---
        if req.image_base64 and req.image_media_type:
            anthropic_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
            extraction = extract_entities_from_image(req.image_base64, req.image_media_type, anthropic_key)
            if extraction.error:
                image_note = extraction.error
            else:
                image_note = extraction.raw_note
                # Fold what the image gave us into the question text so the
                # existing rule-based query_router picks it up naturally,
                # without needing a second code path.
                extras = []
                if extraction.pnr:
                    extras.append(f"PNR {extraction.pnr}")
                if extraction.train_number:
                    extras.append(f"train {extraction.train_number}")
                if extraction.date_ddmmyyyy:
                    extras.append(f"on {extraction.date_ddmmyyyy}")
                if extras:
                    question = (question + " " if question else "") + " ".join(extras)

        if not question:
            return {"answer": "Please type a question — for example a PNR number, a train number with 'running status', or something like 'what happens if my Tatkal ticket is on waitlist?', or attach a photo of your ticket.", "intent": None, "sources": [], "diagrams": []}

        # --- Multi-Language Support: resolve BEFORE classification, using
        # the raw question text (explicit dropdown choice always wins;
        # otherwise detect the actual script the user typed in) ---
        language_choice = language_support.resolve_language(req.language, question)

        classification = query_router.classify(question)
        intent = classification["intent"]
        entities = classification["entities"]

        # --- Real-Time Sentiment and Emotion Analysis: cheap lexicon scan,
        # runs on every message so its tone guidance can steer THIS reply,
        # not a later one ---
        sentiment_result = sentiment_analysis.analyze(question)

        # --- Few-Shot Learning for New Intents: only consulted when the
        # rule-based router had nothing more specific to say, so a taught
        # intent can sharpen a generic FAQ bucket without ever overriding a
        # confident structural match (PNR/live-status/etc.) ---
        few_shot_match = None
        if intent == query_router.Intent.GENERAL_FAQ:
            few_shot_match = few_shot_intents.match(question, get_engine().hybrid._semantic_engine)
            if few_shot_match is None:
                # Truly unrecognized by both the rule-based router and every
                # taught few-shot intent - log it so auto_keyword_discovery
                # can cluster it with similar misses later and auto-teach a
                # new intent, instead of waiting for someone to notice this
                # exact phrasing keeps showing up.
                try:
                    analytics.record_miss(question)
                except Exception:
                    pass

        # --- Smart Help & Tutorial: instant, canned, never touches the RAG
        # or live-data pipeline, so it's always fast and 100% consistent ---
        if intent == query_router.Intent.HELP:
            return {
                "answer": build_help_answer(),
                "intent": intent,
                "sources": [],
                "diagrams": [],
                "map": None,
            }

        live_data, live_error = None, None
        map_payload = None
        trains_between_empty = False
        full_list_text = None  # set only when the user explicitly asked for every stop
        segment_answer_text = None  # set when asking about specific station(s) within a schedule

        if intent == query_router.Intent.PNR_STATUS:
            try:
                live_data = railway_api.get_pnr_status(entities["pnr"])
            except railway_api.RailwayAPIError as e:
                live_error = str(e)

        elif intent == query_router.Intent.LIVE_STATUS:
            if not entities.get("train_number"):
                live_error = "I can check live running status — what's the train number?"
            else:
                try:
                    live_data = railway_api.get_live_train_status(entities["train_number"], entities["date"])
                    # Real-Time GPS Train Tracking: also fetch train-info,
                    # which is where RailKit's REAL per-station coordinates
                    # live - a genuine accuracy upgrade over guessing from a
                    # static station table. Cached 24h, so this is cheap.
                    try:
                        train_info_data = railway_api.get_train_info(entities["train_number"])
                    except railway_api.RailwayAPIError:
                        train_info_data = None
                    position = gps_tracking.parse_live_position(
                        entities["train_number"], live_data, train_info_data
                    )
                    # Train Delay Prediction (ML): blend in a forward-looking
                    # estimate alongside the real currently-reported delay —
                    # fed with REAL distance/route-progress from the
                    # train-info response already fetched above, not just
                    # the current delay figure — clearly labelled and never
                    # presented as the same thing as the reported delay.
                    distance_km, route_progress_ratio = _distance_and_progress_from_route(
                        train_info_data, position.current_station_code
                    )
                    try:
                        delay_pred = delay_prediction.predict_delay(
                            distance_km=distance_km, route_progress_ratio=route_progress_ratio,
                            date_ddmmyyyy=entities.get("date"),
                            current_delay_minutes=position.delay_minutes,
                        )
                    except Exception:
                        delay_pred = None
                    map_payload = {
                        "type": "live_position",
                        "train_number": entities["train_number"],
                        "lat": position.lat,
                        "lng": position.lng,
                        "current_station": position.current_station_name or position.current_station_code,
                        "next_station": position.next_station_name or position.next_station_code,
                        "delay_minutes": position.delay_minutes,
                        "position_source": position.position_source,
                        "predicted_delay_minutes": delay_pred.predicted_delay_minutes if delay_pred else None,
                        "predicted_delay_confidence": delay_pred.confidence if delay_pred else None,
                        "predicted_delay_low_minutes": delay_pred.low_minutes if delay_pred else None,
                        "predicted_delay_high_minutes": delay_pred.high_minutes if delay_pred else None,
                    }
                    try:
                        analytics.record_event(
                            intent=intent, train_number=entities["train_number"],
                            delay_minutes=position.delay_minutes,
                            predicted_delay_minutes=delay_pred.predicted_delay_minutes if delay_pred else None,
                        )
                    except Exception:
                        pass
                except railway_api.RailwayAPIError as e:
                    live_error = str(e)
                    try:
                        analytics.record_event(intent=intent, live_error=True)
                    except Exception:
                        pass

        elif intent == query_router.Intent.SEAT_AVAILABILITY:
            missing = [k for k in ("train_number", "source", "dest") if not entities.get(k)]
            if missing:
                live_error = (
                    "To check seat availability I need the train number, source station code, "
                    "and destination station code (e.g. 'seat availability train 12951 NDLS to BCT on 15-08-2026 in 3A'). "
                    f"Missing: {', '.join(missing)}."
                )
            else:
                # Map preview: source/destination locations come from our own
                # local coordinate table, not the paid API, so this shows
                # even if the live call below fails or the quota is exhausted.
                map_payload = gps_tracking.offline_station_pair_map(entities.get("source"), entities.get("dest"))
                try:
                    travel_class = "SL"
                    for cls in ("1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S", "FC"):
                        if cls.lower() in question.lower():
                            travel_class = cls
                            break
                    live_data = railway_api.get_seat_availability(
                        entities["train_number"], entities["source"], entities["dest"],
                        entities["date"], travel_class,
                    )
                except railway_api.RailwayAPIError as e:
                    live_error = str(e)

        elif intent == query_router.Intent.TRAIN_SCHEDULE:
            if not entities.get("train_number"):
                live_error = "Which train number's schedule would you like to see?"
            else:
                try:
                    raw_schedule = railway_api.get_train_schedule(entities["train_number"])
                    # Interactive Route Map with Stations: parse the SAME
                    # response rather than calling the provider twice.
                    full_route = gps_tracking.parse_route(raw_schedule)

                    # Specific-station question ("arrival time from SC to
                    # KMT", "when does it reach KMT")? query_router now
                    # extracts source/dest station codes for this intent too
                    # - answer directly from the real per-stop data instead
                    # of falling back to a generic full-journey summary that
                    # doesn't actually contain the figure asked for.
                    segment_answer_text = _answer_station_query(
                        full_route, entities["train_number"],
                        entities.get("source"), entities.get("dest"),
                    )

                    # "upto/until/till/before <station>" support: if present,
                    # truncate the route to that station instead of always
                    # returning the full end-to-end journey. If the named
                    # station isn't actually on this train's route, fall back
                    # to the full route honestly rather than silently
                    # ignoring the request or guessing a cutoff point.
                    upto_code = _extract_upto_station(question)
                    upto_not_found = None
                    if upto_code:
                        truncated = _truncate_route_upto(full_route, upto_code)
                        if truncated:
                            route = truncated
                        else:
                            route = full_route
                            upto_not_found = upto_code
                    else:
                        route = full_route

                    map_payload = {
                        "type": "route",
                        "train_number": entities["train_number"],
                        "stations": [
                            {
                                "code": s.code, "name": s.name, "lat": s.lat, "lng": s.lng,
                                "scheduled_arrival": s.scheduled_arrival,
                                "scheduled_departure": s.scheduled_departure,
                                "distance_km": s.distance_km,
                                "has_coordinates": s.has_coordinates,
                            }
                            for s in route
                        ],
                    }
                    # IMPORTANT: don't hand the LLM the raw, full-stop-list
                    # payload above — with 30-40+ stops that's a lot of
                    # tokens, and the model would try to re-enumerate every
                    # stop in its text answer (redundant with the map/table
                    # the frontend already renders from map_payload), which
                    # is exactly what was blowing the output-token budget and
                    # causing responses to cut off mid-sentence. Give it a
                    # compact summary instead — full detail still reaches
                    # the user via the map, just not through the LLM.
                    #
                    # EXCEPTION: if the user explicitly asked for every stop
                    # ("...in the form a list", "all stops", etc.), that's a
                    # real ask, not the default case — render the full list
                    # ourselves straight from `route` (no LLM, so no token/
                    # cost/truncation risk either way) and append it after
                    # the model's short intro line instead of suppressing it.
                    # `route` here is already the upto-truncated version when
                    # applicable, so the list matches what was actually asked.
                    wants_full_list = _wants_full_stop_list(question)
                    if wants_full_list:
                        full_list_text = _format_full_stop_list(route, entities["train_number"])

                    if upto_not_found:
                        note = (
                            f"The user asked for the schedule up to '{upto_not_found}', but that "
                            "station isn't on this train's actual route - say so plainly and show "
                            "the full journey below instead, don't guess a cutoff point."
                        )
                    elif upto_code:
                        note = (
                            f"The user asked for the schedule only up to {route[-1].name} "
                            f"({route[-1].code}), so source_station/destination_station below "
                            "already reflect that partial journey, not the train's full route. "
                            + ("The full requested stop-by-stop list is appended after your reply "
                               "verbatim - give a ONE-sentence intro only, don't list stops yourself."
                               if wants_full_list else
                               "The stop-by-stop timetable for this partial journey is already "
                               "shown separately in the map/table - don't list individual stations.")
                        )
                    else:
                        note = (
                            "The user explicitly asked for the full stop-by-stop list, which will "
                            "be appended after your reply verbatim from real data - just give a "
                            "ONE-sentence intro (e.g. journey overview), do not attempt to list "
                            "stops yourself since it will be duplicated below."
                            if wants_full_list else
                            "The full stop-by-stop timetable is already shown separately to "
                            "the user in an interactive map/table - do not list individual "
                            "intermediate stations here, just summarize the journey."
                        )

                    # Day-of-week / time-window awareness for schedule
                    # questions ("12345 schedule on Mondays 5:30pm-8:20pm")
                    # - this is a fixed/static schedule, not live tracking,
                    # so there's no "which stop is the train at NOW" to
                    # answer; instead point out which stops fall inside the
                    # requested time window, and flag plainly that this
                    # provider doesn't expose a per-day running calendar, so
                    # a day-of-week can't be confirmed as an actual running
                    # day for this train (only that this is its timetable).
                    schedule_time_note = None
                    window = entities.get("time_range")
                    single_time = entities.get("time")
                    if window or single_time:
                        lo_hhmm, hi_hhmm = window if window else (single_time, single_time)
                        lo_m = trains_between._to_minutes(lo_hhmm)
                        hi_m = trains_between._to_minutes(hi_hhmm)
                        if lo_m is not None and hi_m is not None:
                            def _in_window(mins):
                                return lo_m <= mins <= hi_m if lo_m <= hi_m else (mins >= lo_m or mins <= hi_m)
                            near_stops = []
                            for s in route:
                                for t in (s.scheduled_arrival, s.scheduled_departure):
                                    mins = trains_between._to_minutes(t)
                                    if mins is not None and _in_window(mins):
                                        near_stops.append(f"{s.name} ({s.code})")
                                        break
                            schedule_time_note = (
                                f"Stops around {lo_hhmm}\u2013{hi_hhmm}: "
                                + (", ".join(near_stops) if near_stops else "none on this route fall in that window")
                            )
                    if entities.get("day_of_week"):
                        day_note = (
                            f"This is train {entities['train_number']}'s regular timetable; note that "
                            f"this data source doesn't confirm which specific weekdays it actually "
                            f"runs, so treat {entities['day_of_week'].capitalize()} as the day asked "
                            f"about, not a confirmed running day - check live status closer to travel."
                        )
                        schedule_time_note = f"{day_note} {schedule_time_note or ''}".strip()

                    live_data = {
                        "train_number": entities["train_number"],
                        "total_stops": len(route),
                        "source_station": f"{route[0].name} ({route[0].code})" if route else None,
                        "source_departure": route[0].scheduled_departure if route else None,
                        "destination_station": f"{route[-1].name} ({route[-1].code})" if route else None,
                        "destination_arrival": route[-1].scheduled_arrival if route else None,
                        "total_distance_km": route[-1].distance_km if route else None,
                        "note": note,
                        "time_window_note": schedule_time_note,
                    }
                except railway_api.RailwayAPIError as e:
                    live_error = str(e)

        elif intent == query_router.Intent.TRAINS_BETWEEN:
            if not entities.get("source") or not entities.get("dest"):
                live_error = "Which two stations should I search between (e.g. NDLS to CSMT, or just city names like Hyderabad to Vijayawada)?"
            else:
                # Same offline map preview as seat-availability - always
                # available, doesn't touch (or wait on) the paid API/quota.
                map_payload = gps_tracking.offline_station_pair_map(entities.get("source"), entities.get("dest"))
                try:
                    live_data = railway_api.search_trains_between_stations(
                        entities["source"], entities["dest"], entities["date"]
                    )
                    trains = trains_between.parse_trains_list(live_data)
                    if entities.get("time_range"):
                        start_hhmm, end_hhmm = entities["time_range"]
                        trains = trains_between.filter_by_time_range(trains, start_hhmm, end_hhmm)
                    elif entities.get("time"):
                        trains = trains_between.filter_and_sort_by_time(trains, entities["time"])
                    trains_summary = trains_between.format_trains_summary(trains)
                    # The structured provider came back with NOTHING for this
                    # route/date/time combination - could be a real "no
                    # service" case, or (more often for a niche route/time
                    # window) just a gap in this provider's coverage. Flag it
                    # so the web-search gate below tries the open web too,
                    # the same way it already does for GENERAL_FAQ - rather
                    # than the answer defaulting straight to "not available,
                    # call the helpline" when a web search could actually
                    # find the real trains (this is the exact gap that made
                    # this intent's answers noticeably weaker than a general
                    # web-search chatbot's for the same question).
                    trains_between_empty = len(trains) == 0
                    # Replace the opaque raw-dict context with the parsed,
                    # human-readable list - this is what actually stopped
                    # Claude from padding the answer with ungrounded filler
                    # in the error/quota case, and it also gives a clean
                    # list to show even without ANTHROPIC_API_KEY configured.
                    live_data = {
                        "trains_between_summary": trains_summary,
                        "requested_time": entities.get("time"),
                        "requested_time_range": entities.get("time_range"),
                    }
                    if trains_between_empty:
                        live_data["provider_coverage_note"] = (
                            "This provider returned no trains for this exact route/date/time - that "
                            "does NOT necessarily mean none exist. If the web search results below "
                            "name specific trains for this route, present those as the answer "
                            "(with source attribution) rather than telling the user nothing is "
                            "available."
                        )
                    if entities.get("day_of_week"):
                        # No explicit calendar date was given - "on Sundays"
                        # was resolved to the next actual Sunday so the
                        # provider lookup has a real date to query against.
                        # Say so plainly rather than silently substituting
                        # a date the user never typed.
                        live_data["day_of_week_note"] = (
                            f"Interpreted as the next {entities['day_of_week'].capitalize()} "
                            f"({entities['date']}) - if a different date, ask again with the "
                            f"exact date."
                        )
                    if map_payload:
                        map_payload["trains"] = [
                            {"train_number": t.train_number, "train_name": t.train_name,
                             "departure": t.source_departure, "arrival": t.dest_arrival}
                            for t in trains[:10]
                        ]
                except railway_api.RailwayAPIError as e:
                    live_error = str(e)
                    # Provider failed entirely (service down, quota, etc.) -
                    # same reasoning as the empty-results case above: don't
                    # let a backend plumbing problem be the whole answer
                    # when a web search might still find the real trains.
                    trains_between_empty = True

        elif intent == query_router.Intent.NEARBY_STATIONS:
            if not entities.get("station"):
                live_error = "Which station would you like nearby recommendations for (e.g. 'stations near NDLS')?"
            else:
                nearby = nearby_stations.find_nearby_stations(
                    entities["station"], radius_km=entities.get("radius_km") or 150.0, limit=5,
                )
                live_data = {"nearby_stations_summary": nearby_stations.format_nearby_stations(nearby)}
                if nearby.anchor_known:
                    map_payload = {
                        "type": "nearby_stations",
                        "anchor": {"code": nearby.anchor_code, "name": nearby.anchor_name,
                                   "lat": nearby.anchor_lat, "lng": nearby.anchor_lng},
                        "stations": [
                            {"code": s.code, "name": s.name, "lat": s.lat, "lng": s.lng, "distance_km": s.distance_km}
                            for s in nearby.stations
                        ],
                        "radius_km": nearby.radius_km,
                    }

        elif intent == query_router.Intent.ALTERNATIVE_ROUTE:
            if not entities.get("source") or not entities.get("dest"):
                live_error = "Which two stations should I plan an alternative route between (e.g. 'alternative route from NDLS to MAS')?"
            else:
                plan = route_planner.find_alternative_routes(entities["source"], entities["dest"], k=3)
                live_data = {"alternative_routes_summary": route_planner.format_route_options(plan)}
                if plan.options:
                    map_payload = {
                        "type": "alternative_routes",
                        "source": entities["source"], "dest": entities["dest"],
                        "routes": [
                            {
                                "stations": [
                                    {"code": c, "name": n, **({"lat": route_planner._STATION_COORDS[c]["lat"],
                                                                "lng": route_planner._STATION_COORDS[c]["lng"]}
                                                               if c in route_planner._STATION_COORDS else {})}
                                    for c, n in zip(opt.stations, opt.station_names)
                                ],
                                "distance_km": opt.total_distance_km,
                                "hops": opt.hops,
                                "is_direct_corridor": opt.is_direct_corridor,
                            }
                            for opt in plan.options
                        ],
                    }

        elif intent == query_router.Intent.CROWD_PREDICTION:
            missing = [k for k in ("train_number", "source", "dest") if not entities.get(k)]
            if missing:
                live_error = (
                    "To predict crowd levels I need the train number, source, and destination station "
                    f"(e.g. 'how crowded will train 12951 be from NDLS to BCT'). Missing: {', '.join(missing)}."
                )
            else:
                travel_class = "SL"
                for cls in ("1A", "2A", "3A", "3E", "CC", "EC", "SL", "2S", "FC"):
                    if cls.lower() in question.lower():
                        travel_class = cls
                        break
                seat_data, seat_error = None, None
                try:
                    seat_data = railway_api.get_seat_availability(
                        entities["train_number"], entities["source"], entities["dest"],
                        entities["date"], travel_class,
                    )
                except railway_api.RailwayAPIError as e:
                    seat_error = str(e)
                prediction = crowd_prediction.predict_crowd(
                    seat_availability_data=seat_data, travel_class=travel_class,
                    date_ddmmyyyy=entities.get("date"),
                )
                live_data = {"crowd_prediction_summary": crowd_prediction.format_crowd_prediction(prediction)}
                if seat_error:
                    live_data["note"] = f"(Booking-data lookup for a sharper estimate failed: {seat_error} — estimate below uses date/class heuristics only.)"
                try:
                    analytics.record_event(intent=intent, train_number=entities.get("train_number"), crowd_score=prediction.score)
                except Exception:
                    pass

        # --- Advanced RAG pipeline: self-RAG gate -> hybrid retrieval ->
        # graph expansion -> contextual compression -> diagram lookup ---
        # Deep Think toggle: same pipeline, just given more room to work
        # with (more candidate chunks survive to synthesis) rather than a
        # separate code path — the adaptive-retrieval/reasoning-path
        # machinery already in rag_engine handles the rest.
        retrieval = get_engine().retrieve(
            question, top_k=(8 if req.deep_think else 3),
            has_live_data=bool(live_data), has_live_error=bool(live_error),
        )

        if intent not in (query_router.Intent.LIVE_STATUS, query_router.Intent.CROWD_PREDICTION):
            try:
                analytics.record_event(intent=intent, live_error=bool(live_error))
            except Exception:
                pass

        # --- Web Search fallback: for open-ended / FAQ-style questions
        # (the kind the Live Tracking tab's "Ask about this train" box gets
        # a lot of — "why might it be delayed today", "is there fog on this
        # route" — the fixed knowledge base has nothing, and often neither
        # does live train data on its own). Only spend the (soft-failing,
        # cached) web call when it can actually add something: GENERAL_FAQ
        # questions, or any question paired with live tracking data that
        # the KB alone didn't already answer confidently. Never fires for
        # PNR/seat-availability/etc. — those are answered from real
        # provider data only, never the open web. The app's web-search
        # toggle can force this on (True) or off (False) explicitly;
        # leaving it unset keeps this automatic gate as-is.
        web_results = None
        auto_web_search = not segment_answer_text and (
            (intent in (query_router.Intent.GENERAL_FAQ, query_router.Intent.LIVE_STATUS) and not few_shot_match)
            or (intent == query_router.Intent.TRAINS_BETWEEN and trains_between_empty)
        )
        should_web_search = auto_web_search if req.web_search is None else (req.web_search and not segment_answer_text)
        if should_web_search:
            # For a route/availability question, a query built from the
            # resolved station codes/date/time ("BZA to NDL trains time
            # table 03-08-2026") reliably surfaces the train-enquiry sites
            # (erail/ixigo/railyatri/etc.) that actually list real train
            # numbers and timings - searching the raw free-text question
            # verbatim tends to surface generic railway news instead.
            if intent == query_router.Intent.TRAINS_BETWEEN and entities.get("source") and entities.get("dest"):
                search_query = f"{entities['source']} to {entities['dest']} trains time table {entities.get('date') or ''}".strip()
            else:
                search_query = question
            try:
                web_results = web_search.search_web(search_query, max_results=5)
            except Exception:
                web_results = None

        if segment_answer_text:
            answer = segment_answer_text
        else:
            answer = _synthesize(
                question, live_data, retrieval, live_error, language_choice,
                sentiment_result=sentiment_result,
                reasoning_paths=retrieval.reasoning_paths,
                few_shot_hint=few_shot_match.response_hint if few_shot_match else None,
                web_results=web_results,
                deep_think=req.deep_think,
            )
            if full_list_text:
                answer = f"{answer}\n\n{full_list_text}"
        if image_note and req.image_base64:
            answer = f"📷 From your photo: {image_note}\n\n{answer}"

        # --- User Feedback Loop (RLHF data collection): stamp this reply
        # with an id the frontend can later attach a 👍/👎 (+ optional
        # correction) to via POST /api/feedback ---
        response_id = feedback_rlhf.new_response_id()
        try:
            feedback_rlhf.record_response(
                response_id, question=question, answer=answer,
                intent=str(few_shot_match.intent_name if few_shot_match else intent),
                sources=[c.id for c in retrieval.chunks],
            )
        except Exception:
            pass

        return {
            "answer": answer,
            "intent": intent,
            "response_id": response_id,
            "sources": [c.id for c in retrieval.chunks],
            "web_sources": [{"title": r.title, "url": r.url} for r in (web_results or [])],
            "deep_think_used": req.deep_think,
            "diagrams": retrieval.diagrams,
            "map": map_payload,
            "language": {"resolved": language_choice.language, "source": language_choice.source},
            "sentiment": {
                "sentiment": sentiment_result.sentiment,
                "score": sentiment_result.sentiment_score,
                "emotion": sentiment_result.emotion,
                "is_urgent": sentiment_result.is_urgent,
                "is_frustrated": sentiment_result.is_frustrated,
            },
            "rag_trace": {
                "retrieval_performed": retrieval.retrieval_performed,
                "skip_reason": retrieval.skip_reason,
                "used_broadened_search": retrieval.used_broadened_search,
                "used_graph_expansion": retrieval.used_graph_expansion,
                "graph_matched_entities": retrieval.graph_matched_entities,
                "reasoning_paths": retrieval.reasoning_paths,
                "semantic_engine": retrieval.engine_name,
                "few_shot_intent_match": (
                    {"name": few_shot_match.intent_name, "confidence": few_shot_match.confidence}
                    if few_shot_match else None
                ),
            },
        }

    except Exception as e:
        traceback.print_exc()
        return {"answer": f"Something went wrong processing that: {e}", "intent": "error", "sources": [], "diagrams": [], "map": None}


# =============================================================================
# FEATURE: Semantic Station Search with Geo-Coding
# =============================================================================
class StationSearchRequest(BaseModel):
    query: str
    top_k: int = 5


@app.post("/api/stations/search")
def api_station_search(req: StationSearchRequest):
    result = station_search.search_stations(req.query, top_k=max(1, min(req.top_k, 20)))
    return {
        "query": result.query,
        "engine": result.engine_name,
        "note": result.note,
        "matches": [
            {"code": m.code, "name": m.name, "lat": m.lat, "lng": m.lng, "score": m.score, "matched_on": m.matched_on}
            for m in result.matches
        ],
    }


# =============================================================================
# FEATURE: Train Search (real-time filter by source/dest/date/time, paged)
# -----------------------------------------------------------------------
# Same source of truth as the TRAINS_BETWEEN chat intent
# (railway_api.search_trains_between_stations + trains_between.py) - this
# just exposes it as a plain form-friendly REST endpoint instead of only
# being reachable through a natural-language chat message, and adds
# pagination so a user-chosen page size (1-50) controls how many trains
# come back per request instead of the chat flow's fixed 8-line summary.
# =============================================================================
def _resolve_station_code(raw: str) -> Optional[str]:
    """Turns whatever the user typed into a source/dest field (a station
    code, an official name, or a common city alias) into a real RailKit
    station code — same gazetteer the chat flow's entity extraction uses,
    with a fuzzy station_search fallback for names/spellings the gazetteer
    doesn't have an exact alias for. Returns None (never a guess) if
    nothing matches."""
    if not raw or not raw.strip():
        return None
    text = raw.strip()
    exact = entity_gazetteer._GAZETTEER.get(text.lower())
    if exact:
        return exact
    if re.fullmatch(r"[A-Za-z]{2,5}", text):
        # Looks like a station code already (e.g. "VSKP") even if it's
        # not in the gazetteer's curated set - pass it through as-is and
        # let the provider itself say if it's invalid, rather than
        # refusing a real code just because our local list is incomplete.
        return text.upper()
    result = station_search.search_stations(text, top_k=1)
    if result.matches:
        return result.matches[0].code
    return None


class TrainSearchRequest(BaseModel):
    source: str
    dest: str
    date: Optional[str] = None    # dd-mm-yyyy, optional
    time: Optional[str] = None    # "HH:MM" 24h, optional legacy single-field sort (kept for old callers)
    departure_start: Optional[str] = None  # "HH:MM" 24h — start of the departure-time band (IRCTC-style 00-06/06-12/12-18/18-00, or a custom range/point)
    departure_end: Optional[str] = None    # "HH:MM" 24h — end of the departure-time band; equal to departure_start means "around this exact time"
    arrival_start: Optional[str] = None    # "HH:MM" 24h — start of the arrival-time band
    arrival_end: Optional[str] = None      # "HH:MM" 24h — end of the arrival-time band; equal to arrival_start means "around this exact time"
    travel_class: Optional[str] = None   # SL/3A/2A/1A/3E/CC/EC/2S — filters to trains that run this class
    quota: Optional[str] = "GN"          # GN/TQ/PT/LD/SS/HP/LB/DF/HO/PH/FT/PQ/RL/RS — used for live availability, not for the class filter itself
    available_only: Optional[bool] = False    # when class+date given: narrow to trains with a real live AVAILABLE status
    waitlisted_only: Optional[bool] = False   # when class+date given: narrow to trains with a real live WAITLIST status
    limit: int = 10               # page size the user picks, clamped to 1-50
    page: int = 1


@app.post("/api/trains/search")
def api_trains_search(req: TrainSearchRequest):
    limit = max(1, min(req.limit, 50))
    page = max(1, req.page)

    source_code = _resolve_station_code(req.source)
    dest_code = _resolve_station_code(req.dest)
    if not source_code or not dest_code:
        unresolved = req.source if not source_code else req.dest
        return {
            "source": source_code, "dest": dest_code,
            "trains": [], "total": 0, "page": 1, "limit": limit, "total_pages": 1,
            "error": f"Couldn't recognize the station \"{unresolved}\" — try a station code (e.g. NDLS) or its full name.",
        }

    try:
        live_data = railway_api.search_trains_between_stations(source_code, dest_code, req.date)
    except railway_api.RailwayAPIError as e:
        return {
            "source": source_code, "dest": dest_code, "date": req.date, "time": req.time,
            "trains": [], "total": 0, "page": 1, "limit": limit, "total_pages": 1,
            "error": str(e),
        }

    trains = trains_between.parse_trains_list(live_data)

    # RailKit's searchTrainBetweenStations returns the whole weekly
    # timetable regardless of the requested date, so trains that don't
    # actually run on req.date's weekday must be narrowed out here to
    # match what IRCTC's own date-specific search shows. See the
    # filter_by_running_date docstring in trains_between.py.
    date_filter_note = None
    if req.date:
        before_date_filter = len(trains)
        trains, is_exact_date_match, parsed_days_count, total_before = trains_between.filter_by_running_date(trains, req.date)
        if trains and not is_exact_date_match:
            date_filter_note = (
                "Couldn't confirm any train's running days for this date — showing all trains on this route instead."
            )
        elif trains and is_exact_date_match and parsed_days_count == 0 and total_before > 0:
            # is_exact_match came back True, but NOT because every train
            # genuinely runs this weekday - it's because the provider's
            # running-days field was never recognised for a single train,
            # so the filter was a silent no-op (this is what was actually
            # happening before: 14 shown instead of IRCTC's 11, with no
            # error). Surface the real raw field shape so the fix is a
            # one-line field-name addition, not another guess.
            raw_sample = trains_between.raw_row_sample(live_data)
            if raw_sample:
                date_filter_note = (
                    f"Running-days field wasn't recognised for any of the {total_before} train(s) on this route, "
                    "so the date filter couldn't narrow anything down (still showing every weekly train, not just "
                    f"those confirmed to run on {req.date}). RapidAPI's real field names for this row are: "
                    f"{raw_sample['all_keys']}. Day-like fields found: {raw_sample['day_like_fields'] or 'none matched even loosely'}."
                )

    time_filter_note = None
    if req.departure_start or req.departure_end or req.arrival_start or req.arrival_end:
        trains, is_exact_time_match, time_filter_sample = trains_between.filter_by_time_bands(
            trains, req.departure_start, req.departure_end, req.arrival_start, req.arrival_end,
        )
        if trains and not is_exact_time_match:
            # Real evidence, not another blind guess: show the actual
            # parsed departure/arrival values for a few real trains right
            # in the note, so a "didn't match" report is diagnosable from
            # what's on screen - None/None here means the provider's raw
            # field wasn't parsed at all (a parsing bug); real HH:MM
            # values that still don't match a band that should include
            # them means the bug is in the band comparison instead.
            sample_str = "; ".join(
                f"{s['train_number']}: dep={s['source_departure'] or 'unknown'}, arr={s['dest_arrival'] or 'unknown'}"
                for s in time_filter_sample
            )
            time_filter_note = (
                "No trains matched that departure/arrival time — showing all trains on this route instead. "
                f"(Sample of what was actually checked — {sample_str})" if sample_str else
                "No trains matched that departure/arrival time — showing all trains on this route instead."
            )
    elif req.time:
        trains = trains_between.filter_and_sort_by_time(trains, req.time)
    class_filter_note = None
    if req.travel_class:
        before = len(trains)
        trains, is_exact_class_match = trains_between.filter_by_class(trains, req.travel_class)
        class_filtered_out = before - len(trains) if is_exact_class_match else 0
        if trains and not is_exact_class_match:
            class_filter_note = f"No trains confirmed running class {req.travel_class} on this route — showing all trains instead (the provider's class data may be incomplete)."
    else:
        class_filtered_out = None

    # Live seat-availability search: when a class + date are given, check
    # REAL RailKit availability for the leading candidates (capped, so this
    # stays bounded regardless of how many trains matched) and either rank
    # by it (available first) or, if the person asked for available-only,
    # narrow the list to just the trains that currently show a real
    # "AVAILABLE" status — falling back to the full list with an honest
    # note if that would otherwise leave nothing to show.
    AVAILABILITY_CHECK_CAP = 30
    availability_note = None
    availability_cache = {}  # train_number -> (status_text, error)

    def _availability_rank(status_text):
        if not status_text:
            return 3
        if re.search(r"\bAVAILABLE\b", status_text, re.IGNORECASE):
            return 0
        if re.search(r"\bRAC\b", status_text, re.IGNORECASE):
            return 1
        if re.search(r"\bWL\b|WAITLIST", status_text, re.IGNORECASE):
            return 2
        return 3

    def _is_class_confirmed_absent(error_text):
        # RailKit's real per-route availability error text when this exact
        # class genuinely doesn't run on this leg (as opposed to a
        # transient/rate-limit/booking-window error) - matched from the
        # provider's actual observed wording so we only exclude on a real
        # confirmed-absent signal, never a guess.
        if not error_text:
            return False
        return bool(re.search(r"does not exist in this train|class not available", error_text, re.IGNORECASE))

    # FEATURE: fare-on-every-result (was previously only surfaced in the
    # opt-in Route Compare / Fare Heatmap / Journey Planner advanced
    # tools — see journey_planner.py's honesty rules, mirrored here). A
    # per-train fare is only ever meaningful once a travel class is
    # picked (each class has its own price), so this activates on the
    # exact same travel_class+date condition as the live availability
    # check just below, and reuses that same capped/checked list so it
    # doesn't cost extra RailKit calls beyond what's already being made
    # for availability. Capped separately (smaller) from
    # AVAILABILITY_CHECK_CAP because a real get_fare() call is its own
    # RailKit round trip, not free to fetch for 30 trains at once - this
    # is the same _FARE_LOOKUP_CAP=6 budget journey_planner.py uses, kept
    # in sync deliberately rather than duplicated as a magic number.
    FARE_CHECK_CAP = journey_planner._FARE_LOOKUP_CAP
    fare_cache = {}  # train_number -> (amount, error_or_none)
    fare_note = None

    availability_raw_keys_sample = None
    confirmed_absent_note = None
    if req.travel_class and req.date:
        checked = trains[:AVAILABILITY_CHECK_CAP]
        fare_candidates = checked[:FARE_CHECK_CAP]
        for t in fare_candidates:
            try:
                fare_data = railway_api.get_fare(
                    t.train_number, source_code, dest_code, req.date, req.travel_class, (req.quota or "GN").upper(),
                )
                amount = advanced_features.extract_fare_amount(fare_data)
                fare_cache[t.train_number] = (amount, None if amount is not None else "Fare not returned for this class/quota.")
            except railway_api.RailwayAPIError as e:
                fare_cache[t.train_number] = (None, str(e))
        if len(checked) > FARE_CHECK_CAP:
            fare_note = f"Live fare checked for the {FARE_CHECK_CAP} closest-matching trains only; the rest show timing/availability only — open a train's details or use Journey Planner for its fare."
        for t in checked:
            try:
                avail = railway_api.get_seat_availability(
                    t.train_number, source_code, dest_code, req.date, req.travel_class, (req.quota or "GN").upper(),
                )
                status_text = advanced_features.extract_status_text(avail, req.date)
                availability_cache[t.train_number] = (status_text, None)
                # If a call succeeded but no status could be extracted at
                # all, keep one real sample of the response's actual key
                # shape so a future mismatch (a shape this deep-search
                # still doesn't cover) can be fixed from real evidence
                # instead of another guess, same pattern as PNR/history.
                if status_text is None and availability_raw_keys_sample is None:
                    availability_raw_keys_sample = top_level_keys(avail)
            except railway_api.RailwayAPIError as e:
                availability_cache[t.train_number] = (None, str(e))

        # A train RailKit explicitly confirms doesn't run this class on
        # this leg is never a real match for what was asked for - drop it
        # unconditionally, regardless of which checkbox (if any) is
        # ticked. This is what was missing: e.g. a GN/1A search that
        # matched a train only via the coarser static classes list, but
        # whose live per-route check comes back "class does not exist",
        # was still being shown as a result even though IRCTC (and
        # RailKit itself) confirm it isn't real for this route/date.
        confirmed_absent_ids = {
            t.train_number for t in checked
            if _is_class_confirmed_absent(availability_cache.get(t.train_number, (None, None))[1])
        }
        if confirmed_absent_ids:
            trains = [t for t in trains if t.train_number not in confirmed_absent_ids]
            checked = [t for t in checked if t.train_number not in confirmed_absent_ids]
            confirmed_absent_note = (
                f"{len(confirmed_absent_ids)} train(s) confirmed by RapidAPI not to run class "
                f"{req.travel_class} on this route/date were excluded."
            )

        # available_only / waitlisted_only can be combined (show both real
        # outcomes) or used alone; with neither ticked, every train that
        # wasn't confirmed-absent above is shown, sorted by rank.
        wanted_ranks = set()
        if req.available_only:
            wanted_ranks.add(0)
        if req.waitlisted_only:
            wanted_ranks.add(2)

        if wanted_ranks:
            responded = [t for t in checked if availability_cache.get(t.train_number, (None, "x"))[1] is None]
            matched = [t for t in responded if _availability_rank(availability_cache[t.train_number][0]) in wanted_ranks]
            if matched:
                trains = matched
            elif responded:
                # Nothing matched the requested tier(s), but these trains
                # DID get a real per-route response from RailKit - show
                # them anyway (closest-match-first) rather than a dead
                # end, and say plainly why.
                trains = sorted(responded, key=lambda t: _availability_rank(availability_cache[t.train_number][0]))
                wanted_label = {0: "AVAILABLE", 2: "waitlisted"}
                label = " or ".join(wanted_label[r] for r in sorted(wanted_ranks))
                availability_note = f"No trains currently show {label} status for {req.travel_class}/{(req.quota or 'GN').upper()} on {req.date} — showing the trains RapidAPI confirms run this class on this route instead, closest match first."
            else:
                trains = []
                availability_note = f"Couldn't confirm live {req.travel_class}/{(req.quota or 'GN').upper()} availability for any train on this route on {req.date}."
        else:
            checked_sorted = sorted(checked, key=lambda t: _availability_rank(availability_cache.get(t.train_number, (None, None))[0]))
            uncached_tail = [t for t in trains[AVAILABILITY_CHECK_CAP:] if t.train_number not in confirmed_absent_ids]
            trains = checked_sorted + uncached_tail
            if len(trains) > AVAILABILITY_CHECK_CAP:
                availability_note = f"Live availability checked and used to sort the first {AVAILABILITY_CHECK_CAP} trains; further trains are shown unchecked."
    elif req.travel_class and not req.date:
        availability_note = "Pick a date to see live seat availability for this class/quota."
        fare_note = "Pick a date to see live fare for this class/quota."
    elif not req.travel_class:
        fare_note = "Pick a travel class to see live fare — fare depends on class, so there's no single honest per-train price to show without one."

    page_trains, page, total, total_pages = trains_between.paginate_trains(trains, page, limit)
    page_dicts = [trains_between.train_to_dict(t) for t in page_trains]
    for row in page_dicts:
        cached = availability_cache.get(row["train_number"])
        row["availability_status"], row["availability_error"] = cached if cached else (None, None)
        fare_cached = fare_cache.get(row["train_number"])
        row["fare"], row["fare_error"] = fare_cached if fare_cached else (None, None)
        row["quota"] = (req.quota or "GN").upper() if req.travel_class else None

    # Diagnostic, evidence-first: if ANY train on this page has no parsed
    # departure/arrival (visible in the UI as a row with no "dep"/"arr"
    # text, just a duration), that's the real root cause of any
    # departure/arrival time-band filter looking "wrong" for that train -
    # the value never parsed out of RapidAPI's response, so no band could
    # ever match it. Triggers on ANY missing train, not just when EVERY
    # train on the page is missing one (a mixed page - some trains parse
    # fine, some don't - was silently hiding this note entirely before).
    # Samples the raw shape of a train that's ACTUALLY missing its time,
    # not just row zero, since row zero might be one of the trains that
    # parsed fine and would show a misleadingly "normal" shape.
    parse_diagnostic_note = None
    missing_time_trains = [r["train_number"] for r in page_dicts if not r["departure_time"] and not r["arrival_time"]]
    if missing_time_trains:
        raw_sample = trains_between.raw_row_sample(live_data, train_number=missing_time_trains[0])
        if raw_sample:
            parse_diagnostic_note = (
                f"Departure/arrival didn't parse for {len(missing_time_trains)} of {len(page_dicts)} train(s) on this page "
                f"(e.g. train {missing_time_trains[0]}) — not just the time filter. "
                f"RapidAPI's real field names for that train's row are: {raw_sample['all_keys']}. "
                f"Time-like fields found: {raw_sample['time_like_fields'] or 'none matched even loosely'}."
            )

    return {
        "source": source_code, "dest": dest_code, "date": req.date, "time": req.time,
        "departure_start": req.departure_start, "departure_end": req.departure_end,
        "arrival_start": req.arrival_start, "arrival_end": req.arrival_end,
        "travel_class": req.travel_class, "quota": (req.quota or "GN").upper() if req.travel_class else None,
        "available_only": bool(req.available_only),
        "waitlisted_only": bool(req.waitlisted_only),
        "trains": page_dicts,
        "total": total, "page": page, "limit": limit, "total_pages": total_pages,
        "class_filtered_out": class_filtered_out,
        "fare_note": fare_note,
        "fare_provider": "RailKit (third-party) — not IRCTC's own live/dynamic Tatkal pricing; see fare_note.",
        "availability_note": availability_note,
        "availability_raw_keys_sample": availability_raw_keys_sample,
        "confirmed_absent_note": confirmed_absent_note,
        "date_filter_note": date_filter_note,
        "time_filter_note": time_filter_note,
        "class_filter_note": class_filter_note,
        "parse_diagnostic_note": parse_diagnostic_note,
        "error": None if total else "No trains found for this route (and date, if given).",
    }


# =============================================================================
# FEATURE: Personalized Journey Planner
# -----------------------------------------------------------------------
# One "plan my journey" answer built from pieces this app already has for
# real (Search Trains' direct-train lookup + route_planner's real
# junction-hopping graph), ranked by a real preference. See
# journey_planner.py for the honesty rules (fare only ever shown when a
# real class was given and a real get_fare() call succeeded; no leg ever
# gets an invented train).
#
# last_mile in the response carries the source/dest stations' real
# curated lat/lng (same table route_planner/nearby_stations already use)
# so the frontend can build genuine Uber/Ola deep-link URLs (no partner
# API key needed for a deep link — it just opens their app with pickup
# pre-filled) rather than fabricating a fare/ETA this app has no way to
# get without one of those partner integrations.
# =============================================================================
class JourneyPlanRequest(BaseModel):
    source: str
    dest: str
    date: Optional[str] = None            # dd-mm-yyyy, optional
    preference: str = "fastest"           # fastest | cheapest | fewest_changes
    travel_class: Optional[str] = None    # needed for real fare-based "cheapest" ranking
    quota: Optional[str] = "GN"


@app.post("/api/journey/plan")
def api_journey_plan(req: JourneyPlanRequest):
    source_code = _resolve_station_code(req.source)
    dest_code = _resolve_station_code(req.dest)
    if not source_code or not dest_code:
        unresolved = req.source if not source_code else req.dest
        return {
            "error": f"Couldn't recognize the station \"{unresolved}\" — try a station code (e.g. NDLS) or its full name.",
            "direct_options": [], "alternative_routes": [],
        }
    if source_code == dest_code:
        return {
            "error": "Source and destination are the same station.",
            "source": source_code, "dest": dest_code,
            "direct_options": [], "alternative_routes": [],
        }

    plan = journey_planner.plan_journey(
        source_code, dest_code, req.date, req.preference, req.travel_class, (req.quota or "GN").upper(),
    )
    result = journey_planner.journey_plan_to_dict(plan)

    def _station_point(code: str):
        info = route_planner._STATION_COORDS.get(code)
        return {"code": code, "name": info["name"] if info else code,
                "lat": info["lat"] if info else None, "lng": info["lng"] if info else None}

    result["last_mile"] = {
        "source_station": _station_point(source_code),
        "dest_station": _station_point(dest_code),
    }

    # FEATURE: Trip Planning with Alternative Transport (Bus/Flight).
    # See alt_transport.py. Triggered when this app genuinely has no usable
    # train option to offer — no direct train AND no junction-hopping
    # alternative with every leg confirmed by a real train — same "don't
    # just say no, suggest the next-best real option" spirit as the
    # last_mile Uber/Ola block above, just for the long-haul leg instead of
    # the final few km.
    no_train_option = not plan.direct_options and not any(r.all_legs_confirmed for r in plan.alternative_routes)
    if no_train_option:
        alt_suggestion = alt_transport.suggest_alternative_transport(source_code, dest_code)
        result["alt_transport"] = alt_transport.to_dict(alt_suggestion)
    else:
        result["alt_transport"] = None

    result["error"] = None
    return result


# =============================================================================
# FEATURE: Route Stats (RailRadar) — avg distance, avg time, and real
# distance between each major stop for a given train number. See
# railradar_fallback.py: get_route_averages() / get_major_stop_distances().
# =============================================================================
@app.get("/api/train/{train_number}/route-stats")
def api_train_route_stats(train_number: str):
    averages = railradar_fallback.get_route_averages(train_number)
    stops = railradar_fallback.get_major_stop_distances(train_number)
    if averages is None and not stops:
        # Surface the REAL reason (bad key, train not found, rate limit,
        # network error) instead of a generic message — see
        # railradar_fallback.get_last_error().
        reason = railradar_fallback.get_last_error()
        return {
            "train_number": train_number,
            "available": False,
            "note": reason or ("No RailRadar data for this train — check RAILRADAR_API_KEY is set in "
                                "backend/.env and that the train number is correct."),
        }
    return {
        "train_number": train_number,
        "available": True,
        "avg_distance_km_between_halts": (averages or {}).get("avg_distance_km_between_halts"),
        "avg_time_minutes_between_halts": (averages or {}).get("avg_time_minutes_between_halts"),
        "total_distance_km": (averages or {}).get("total_distance_km"),
        "total_halts": (averages or {}).get("total_halts"),
        "basis": (averages or {}).get("basis"),
        "stops": stops,
    }


# =============================================================================
# FEATURE: Train Delay Prediction (ML Model)
# =============================================================================
class DelayPredictRequest(BaseModel):
    train_number: Optional[str] = None
    source: Optional[str] = None
    dest: Optional[str] = None
    date: Optional[str] = None            # dd-mm-yyyy
    time: Optional[str] = None            # HH:MM
    travel_class: Optional[str] = None
    current_delay_minutes: Optional[int] = None  # pass a real reported delay if you have one
    # FEATURE: label-aware delay alerts. When set, the prediction targets
    # THIS specific station on the train's real route (matched against the
    # live timeline — see _match_station_in_timeline) instead of just "the
    # next reporting station" — see _predict_for_watch_station for the
    # three real outcomes (not_on_route / already_reached / predicted).
    # Left unset, every existing caller of this endpoint gets the exact
    # same behavior as before this feature existed.
    station_label: Optional[str] = None


@app.post("/api/delay/predict")
def api_delay_predict(req: DelayPredictRequest):
    if req.train_number and req.station_label:
        # Label-aware path — separate pipeline from the generic one below
        # so the original (no-label) behavior is completely untouched for
        # every other caller (in-app alerts before this feature, any
        # other integration hitting this endpoint directly, etc.).
        result = _predict_for_watch_station(req.train_number, req.date, req.station_label, req.travel_class)
        try:
            analytics.record_event(
                intent="delay_prediction_labeled", train_number=req.train_number,
                delay_minutes=req.current_delay_minutes, predicted_delay_minutes=result.get("delay_minutes"),
            )
        except Exception:
            pass
        return {
            "predicted_delay_minutes": result.get("delay_minutes"),
            "confidence": result.get("confidence"),
            "station_status": result["status"],       # "not_on_route" | "already_reached" | "predicted" | "unavailable"
            "station": result.get("station"),
            "already_reached_at": result.get("actual_time"),
            "predicted_eta": result.get("predicted_eta"),
            "current_station": result.get("current_station"),
            "message": result.get("message"),
            "disclaimer": "Live-data-driven estimate, not a RailKit-confirmed figure, until the station is actually reached.",
        }

    distance_km = None
    route_progress_ratio = None
    current_delay_minutes = req.current_delay_minutes
    position = None
    trend = {"trend_per_stop": None, "basis": None}
    avg_speed_kmph, avg_speed_basis = None, None
    timeline_stops = []

    # If a train number is given, pull REAL live position + route data
    # (same RailKit calls the live-tracking feature uses). Fetched as two
    # INDEPENDENT calls (not one nested inside the other) so a failure in
    # either one still leaves whatever real data the other succeeded at —
    # e.g. train-info succeeding even when live status is briefly down
    # still gives the model a real distance figure instead of falling all
    # the way back to an assumed default.
    if req.train_number:
        train_info_data = None
        try:
            train_info_data = railway_api.get_train_info(req.train_number)
        except railway_api.RailwayAPIError:
            pass

        try:
            live_data = railway_api.get_live_train_status(req.train_number, req.date)
            position = gps_tracking.parse_live_position(req.train_number, live_data, train_info_data)
            if current_delay_minutes is None:
                current_delay_minutes = position.delay_minutes
            # Real crossed-station delay trend + average running speed —
            # e.g. "20833 crossed VSKP +5, SLO +10, RJY +10, BZA +15" —
            # feeds the model's two strongest next-station predictors.
            timeline_stops = gps_tracking.parse_full_timeline(live_data, train_info_data)
            trend = gps_tracking.compute_recent_delay_trend(timeline_stops)
        except railway_api.RailwayAPIError:
            pass

        # Prefer the user-supplied source station's progress along the
        # route if given (e.g. planning a future leg); otherwise fall
        # back to the train's REAL current position from live data.
        reference_station = req.source or (position.current_station_code if position else None)
        distance_km, route_progress_ratio = _distance_and_progress_from_route(
            train_info_data, reference_station
        )
        # Combines BOTH real providers (RailKit + RailRadar), then an ML
        # instant estimate only as a last resort - see _resolve_avg_speed.
        avg_speed_kmph, avg_speed_basis, _avg_speed_source = _resolve_avg_speed(
            req.train_number, timeline_stops, route_progress_ratio, distance_km,
            req.date, req.time, current_delay_minutes, trend.get("trend_per_stop"),
        )

    prediction = delay_prediction.predict_delay(
        distance_km=distance_km, date_ddmmyyyy=req.date, time_hhmm=req.time,
        route_progress_ratio=route_progress_ratio, current_delay_minutes=current_delay_minutes,
        travel_class=req.travel_class,
        recent_delay_trend_per_stop=trend.get("trend_per_stop"), recent_delay_basis=trend.get("basis"),
        avg_speed_kmph=avg_speed_kmph, avg_speed_basis=avg_speed_basis,
    )
    try:
        analytics.record_event(
            intent="delay_prediction", train_number=req.train_number,
            delay_minutes=current_delay_minutes, predicted_delay_minutes=prediction.predicted_delay_minutes,
        )
    except Exception:
        pass
    return {
        "predicted_delay_minutes": prediction.predicted_delay_minutes,
        "confidence": prediction.confidence,
        # Confidence band (see delay_prediction._confidence_band) - an
        # honest +/- range around the point estimate instead of implying
        # false precision, widening as real signal gets scarcer.
        "predicted_delay_low_minutes": prediction.low_minutes,
        "predicted_delay_high_minutes": prediction.high_minutes,
        "basis": prediction.basis,
        "model_name": prediction.model_name,
        "disclaimer": prediction.disclaimer,
        "current_station": position.current_station_name if position else None,
    }


# =============================================================================
# FEATURE: Train Delay Prediction with Explainable AI
# -----------------------------------------------------------------------
# See delay_explainability.py — real SHAP (KernelExplainer) attribution
# over the SAME blended ensemble /api/delay/predict uses, plus the live
# weather delay component and a real historical weekday comparison, so the
# caller gets an honest "why" breakdown next to the headline number instead
# of just the figure alone. Gathers the exact same real-data inputs
# /api/delay/predict does (train position, route distance/progress, recent
# delay trend, average speed) — kept as its own endpoint/gathering block
# (same duplication pattern the live-tracking websocket handler already
# uses relative to this REST endpoint) so neither code path risks breaking
# the other.
# =============================================================================
class DelayExplainRequest(BaseModel):
    train_number: Optional[str] = None
    source: Optional[str] = None
    dest: Optional[str] = None
    date: Optional[str] = None            # dd-mm-yyyy
    time: Optional[str] = None            # HH:MM
    travel_class: Optional[str] = None
    current_delay_minutes: Optional[int] = None
    include_historical: Optional[bool] = True   # set False to skip the (slower) real history lookup
    historical_lookback_days: Optional[int] = 10


@app.post("/api/delay/explain")
def api_delay_explain(req: DelayExplainRequest):
    distance_km = None
    route_progress_ratio = None
    current_delay_minutes = req.current_delay_minutes
    position = None
    trend = {"trend_per_stop": None, "basis": None}
    avg_speed_kmph, avg_speed_basis = None, None
    timeline_stops = []
    weather_component_minutes, weather_basis = 0.0, None
    current_station_name = None

    if req.train_number:
        train_info_data = None
        try:
            train_info_data = railway_api.get_train_info(req.train_number)
        except railway_api.RailwayAPIError:
            pass

        try:
            live_data = railway_api.get_live_train_status(req.train_number, req.date)
            position = gps_tracking.parse_live_position(req.train_number, live_data, train_info_data)
            if current_delay_minutes is None:
                current_delay_minutes = position.delay_minutes
            timeline_stops = gps_tracking.parse_full_timeline(live_data, train_info_data)
            trend = gps_tracking.compute_recent_delay_trend(timeline_stops)
            current_station_name = position.current_station_name

            # Real weather reading at the train's current position — same
            # source and same bounded fog/heavy-rain heuristic the
            # live-tracking websocket already folds in (see weather.py).
            # Best-effort: no key configured or a failed call just means
            # no weather line, never a guessed one.
            try:
                current_weather = weather.get_current_weather(position.lat, position.lng)
                weather_component_minutes, weather_basis = weather.weather_delay_component_minutes(current_weather)
            except Exception:
                pass
        except railway_api.RailwayAPIError:
            pass

        reference_station = req.source or (position.current_station_code if position else None)
        distance_km, route_progress_ratio = _distance_and_progress_from_route(
            train_info_data, reference_station
        )
        avg_speed_kmph, avg_speed_basis, _avg_speed_source = _resolve_avg_speed(
            req.train_number, timeline_stops, route_progress_ratio, distance_km,
            req.date, req.time, current_delay_minutes, trend.get("trend_per_stop"),
        )

    historical_headline = None
    if req.train_number and req.include_historical:
        try:
            pattern = historical_delay.get_historical_pattern(
                req.train_number, max(1, min(req.historical_lookback_days or 10, 30))
            )
            historical_headline = historical_delay.headline(pattern.get("weekday_summary", []))
        except Exception:
            historical_headline = None

    explanation = delay_explainability.explain_delay(
        distance_km=distance_km, date_ddmmyyyy=req.date, time_hhmm=req.time,
        route_progress_ratio=route_progress_ratio, current_delay_minutes=current_delay_minutes,
        travel_class=req.travel_class,
        recent_delay_trend_per_stop=trend.get("trend_per_stop"), recent_delay_basis=trend.get("basis"),
        avg_speed_kmph=avg_speed_kmph, avg_speed_basis=avg_speed_basis,
        weather_component_minutes=weather_component_minutes, weather_basis=weather_basis,
        historical_headline=historical_headline,
    )

    try:
        analytics.record_event(
            intent="delay_explanation", train_number=req.train_number,
            delay_minutes=current_delay_minutes, predicted_delay_minutes=explanation.prediction.predicted_delay_minutes,
        )
    except Exception:
        pass

    return {
        "predicted_delay_minutes": explanation.prediction.predicted_delay_minutes,
        "confidence": explanation.prediction.confidence,
        "predicted_delay_low_minutes": explanation.prediction.low_minutes,
        "predicted_delay_high_minutes": explanation.prediction.high_minutes,
        "basis": explanation.prediction.basis,
        "model_name": explanation.prediction.model_name,
        "disclaimer": explanation.prediction.disclaimer,
        "current_station": current_station_name,
        "explainer_method": explanation.explainer_method,
        "attributions": [
            {
                "key": a.key, "label": a.label, "minutes": round(a.minutes, 1),
                "pct_of_total": a.pct_of_total, "is_shap": a.is_shap,
            }
            for a in explanation.attributions
        ],
        "narrative": explanation.narrative,
        "historical_headline": explanation.historical_headline,
        "shap_error": explanation.shap_error,
    }


# =============================================================================
# FEATURE: Train Capacity & Crowd Prediction — dedicated endpoint
# =============================================================================
class CrowdPredictRequest(BaseModel):
    train_number: str
    source: str
    dest: str
    date: str                              # dd-mm-yyyy
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"


@app.post("/api/crowd/predict")
def api_crowd_predict(req: CrowdPredictRequest):
    """Real booking-demand-driven crowd estimate for one specific train/
    route/date/class. Pulls REAL seat-availability data from RailKit first
    (the actual current WL/RAC/available-seat numbers are the strongest
    signal crowd_prediction.py has) and always returns the full basis list
    plus the disclaimer — never just a bare level/score — so the caller has
    a genuine explanation of exactly what drove the estimate, not just the
    number itself."""
    seat_data, seat_error = None, None
    try:
        seat_data = railway_api.get_seat_availability(
            req.train_number, req.source, req.dest, req.date,
            (req.travel_class or "SL").upper(), (req.quota or "GN").upper(),
        )
    except railway_api.RailwayAPIError as e:
        seat_error = str(e)

    prediction = crowd_prediction.predict_crowd(
        seat_availability_data=seat_data, travel_class=req.travel_class, date_ddmmyyyy=req.date,
    )
    try:
        analytics.record_event(intent="crowd_prediction", train_number=req.train_number, crowd_score=prediction.score)
    except Exception:
        pass
    return {
        "level": prediction.level,
        "score": prediction.score,
        "basis": prediction.basis,
        "disclaimer": prediction.disclaimer,
        "seat_data_error": seat_error,
    }


# =============================================================================
# FEATURE: Crowd-Sourced Train Position Reports
# -----------------------------------------------------------------------
# See crowd_position_store.py (persistence + gamification) and
# crowd_position_tracking.py (Kalman-filter fusion of RailKit's official
# position with recent passenger-submitted GPS reports). A DIFFERENT
# feature from Train Capacity & Crowd Prediction above — that one estimates
# how CROWDED a train is; this one estimates WHERE a less-tracked train
# actually is, filling gaps in official GPS coverage with real passenger
# phones.
# =============================================================================
class PositionReportRequest(BaseModel):
    train_number: str
    reporter_id: str            # anonymous, app-generated + persisted device id (see mobile app)
    lat: float
    lng: float
    date: Optional[str] = None
    accuracy_meters: Optional[float] = None   # from the phone's location API, when available
    station_hint: Optional[str] = None        # optional free-text ("just left VSKP") — display only


@app.post("/api/crowd-position/report")
def api_submit_position_report(req: PositionReportRequest):
    if not (-90.0 <= req.lat <= 90.0) or not (-180.0 <= req.lng <= 180.0):
        return {"error": "lat/lng out of range — not stored."}
    result = crowd_position_store.submit_report(
        train_number=req.train_number, reporter_id=req.reporter_id, lat=req.lat, lng=req.lng,
        date=req.date, accuracy_meters=req.accuracy_meters, station_hint=req.station_hint,
    )
    try:
        analytics.record_event(intent="crowd_position_report", train_number=req.train_number)
    except Exception:
        pass
    return result


@app.get("/api/crowd-position/{train_number}")
def api_get_fused_position(train_number: str, date: Optional[str] = None):
    """
    Real official position (same RailKit call gps_tracking.py's other
    consumers make) fused with recent passenger reports for this train —
    see crowd_position_tracking.fuse_position for the Kalman-filter
    mechanics. Works even if RailKit has nothing for this train right now
    (position_source falls back to "crowd_sourced"/"crowd_sourced_unconfirmed"),
    and even if no passenger has reported yet (falls back to "official").
    """
    official_lat = official_lng = official_source = None
    current_station_name = None
    try:
        live_data = railway_api.get_live_train_status(train_number, date)
        train_info_data = None
        try:
            train_info_data = railway_api.get_train_info(train_number)
        except railway_api.RailwayAPIError:
            pass
        position = gps_tracking.parse_live_position(train_number, live_data, train_info_data)
        if position.lat is not None and position.lng is not None:
            official_lat, official_lng, official_source = position.lat, position.lng, position.position_source
        current_station_name = position.current_station_name
    except railway_api.RailwayAPIError:
        pass

    reports = crowd_position_store.recent_reports_for_train(
        train_number, max_age_seconds=crowd_position_tracking._REPORT_MAX_AGE_SECONDS
    )
    fused = crowd_position_tracking.fuse_position(
        train_number=train_number, official_lat=official_lat, official_lng=official_lng,
        official_position_source=official_source, reports=reports,
    )
    return {
        "train_number": train_number,
        "lat": fused.lat, "lng": fused.lng,
        "uncertainty_radius_m": fused.uncertainty_radius_m,
        "confidence_label": fused.confidence_label,
        "position_source": fused.position_source,
        "n_confirming_reports": fused.n_confirming_reports,
        "n_total_reports": fused.n_total_reports,
        "official_position_source": official_source,
        "current_station": current_station_name,
        "disclaimer": fused.disclaimer,
    }


@app.get("/api/crowd-position/reporter/{reporter_id}")
def api_reporter_stats(reporter_id: str):
    return crowd_position_store.reporter_stats(reporter_id)


class ReporterNameRequest(BaseModel):
    display_name: Optional[str] = None


@app.post("/api/crowd-position/reporter/{reporter_id}/name")
def api_set_reporter_name(reporter_id: str, req: ReporterNameRequest):
    crowd_position_store.set_display_name(reporter_id, req.display_name)
    return crowd_position_store.reporter_stats(reporter_id)


@app.get("/api/crowd-position/leaderboard/top")
def api_position_leaderboard(limit: int = 10):
    return {"leaderboard": crowd_position_store.leaderboard(limit), "stats": crowd_position_store.stats()}


# =============================================================================
# FEATURE 1: "When Should I Leave?" Smart Departure Reminder
# =============================================================================
class DepartureReminderRequest(BaseModel):
    train_number: str
    boarding_station: str
    date: Optional[str] = None            # dd-mm-yyyy
    mode: Optional[str] = "walk"           # walk | cycle | auto | bike | car | bus | metro | taxi
    distance_km: Optional[float] = None
    user_lat: Optional[float] = None
    user_lng: Optional[float] = None
    boarding_buffer_minutes: Optional[int] = smart_features.DEFAULT_BOARDING_BUFFER_MINUTES


@app.post("/api/advanced/departure-reminder")
def api_departure_reminder(req: DepartureReminderRequest):
    return smart_features.departure_reminder(
        req.train_number, req.boarding_station, req.date, req.mode or "walk",
        req.distance_km, req.user_lat, req.user_lng,
        req.boarding_buffer_minutes if req.boarding_buffer_minutes is not None else smart_features.DEFAULT_BOARDING_BUFFER_MINUTES,
    )


# =============================================================================
# FEATURE 3: "Smart Alarm" Based on Real-Time Train Position
# =============================================================================
class SmartAlarmRequest(BaseModel):
    train_number: str
    destination_station: str
    date: Optional[str] = None
    lead_minutes: Optional[float] = 10.0
    lead_km: Optional[float] = None


def _alarm_check_for_watch(train_number: str, station: str, date: Optional[str], lead_minutes: float, lead_km: Optional[float] = None) -> dict:
    """
    Shared real live-position-driven Smart Alarm check — used by the
    on-demand /api/advanced/smart-alarm endpoint below AND (via app.py's
    startup wiring) alert_scheduler's background job + the live-tracking
    websocket trigger, so a background push and the in-tab alarm never
    diverge. See api_smart_alarm's original docstring (kept below) for why
    the predicted-delay lookup happens here rather than trusting RailKit
    alone.
    """
    predicted_delay_minutes = None
    predicted_delay_confidence = None
    try:
        watch_result = _predict_for_watch_station(train_number, date, station)
        if watch_result.get("status") == "predicted":
            predicted_delay_minutes = watch_result.get("delay_minutes")
            predicted_delay_confidence = watch_result.get("confidence")
    except Exception:
        pass  # smart_alarm_check still works fine on RailKit's own data alone

    return smart_features.smart_alarm_check(
        train_number, station, date, lead_minutes, lead_km,
        predicted_delay_minutes=predicted_delay_minutes,
        predicted_delay_confidence=predicted_delay_confidence,
    )


@app.post("/api/advanced/smart-alarm")
def api_smart_alarm(req: SmartAlarmRequest):
    # BUGFIX: this used to alarm purely off RailKit's own expected/scheduled
    # arrival, which silently ignores this app's own delay prediction until
    # RailKit itself publishes a live delay figure for the destination
    # station — e.g. a real case reported against train 20833 at RJY:
    # scheduled 20:43, this app's own predicted delay +30 min (predicted
    # arrival 21:13), but the alarm fired at 20:33 (10 min before the
    # un-delayed 20:43) instead of 21:03 (10 min before 21:13). Fetch the
    # SAME predicted-delay figure the Live Tracking tab and delay alerts
    # already show for this exact station (`_predict_for_watch_station`,
    # cached RailKit calls underneath so this is a cheap extra lookup, not
    # a second live fetch) and hand it to smart_alarm_check, which only
    # actually uses it when RailKit has no real live delay of its own yet
    # for this station (see that function's docstring) — RailKit's own
    # figure still wins whenever it's real.
    return _alarm_check_for_watch(
        req.train_number, req.destination_station, req.date,
        req.lead_minutes if req.lead_minutes is not None else 10.0, req.lead_km,
    )


# =============================================================================
# FEATURE 5: "Transit Time Optimizer" — Best Train for Your Schedule
# =============================================================================
class TransitOptimizerRequest(BaseModel):
    source: str
    dest: str
    date: Optional[str] = None
    depart_after: Optional[str] = None     # "HH:MM"
    depart_before: Optional[str] = None
    arrive_after: Optional[str] = None
    arrive_before: Optional[str] = None
    preferred_arrival: Optional[str] = None
    max_duration_hours: Optional[float] = None


@app.post("/api/advanced/transit-optimizer")
def api_transit_optimizer(req: TransitOptimizerRequest):
    source_code = _resolve_station_code(req.source)
    dest_code = _resolve_station_code(req.dest)
    if not source_code or not dest_code:
        unresolved = req.source if not source_code else req.dest
        return {"trains": [], "error": f"Couldn't recognize the station \"{unresolved}\" — try a station code (e.g. NDLS) or its full name."}

    try:
        live_data = railway_api.search_trains_between_stations(source_code, dest_code, req.date)
    except railway_api.RailwayAPIError as e:
        return {"trains": [], "source": source_code, "dest": dest_code, "error": str(e)}

    trains = trains_between.parse_trains_list(live_data)
    if req.date:
        trains, _is_exact, _parsed_count, _total = trains_between.filter_by_running_date(trains, req.date)
    train_dicts = [trains_between.train_to_dict(t) for t in trains]

    result = smart_features.rank_trains_for_schedule(
        train_dicts, req.depart_after, req.depart_before, req.arrive_after, req.arrive_before,
        req.preferred_arrival, req.max_duration_hours,
    )
    result["source"], result["dest"], result["date"] = source_code, dest_code, req.date
    return result


# =============================================================================
# FEATURE 6: "Route Visualization" with Time-Lapse
# =============================================================================
@app.get("/api/advanced/route-timelapse/{train_number}")
def api_route_timelapse(train_number: str):
    return smart_features.route_timelapse(train_number)


# NOTE: "Live Crowd Map for Train Coaches" and "Water/Restroom Availability
# Live Check" were removed — neither RailKit (RapidAPI) nor RailRadar, the
# two live-data providers this app has access to, expose any real
# per-coach occupancy or water/restroom sensor feed, and a crowdsourced-
# only version was intentionally dropped rather than shipped as a feature
# with no real data behind it yet. See coach_conditions_store.py in git
# history if reviving this with a real data source later.


# =============================================================================
# FEATURE: "More Tools" panel — Platform Predictor, Pantry Menu, Station
# Amenities, Coach Layout, Seat Recommender, Refund Estimator (all in
# advanced_features.py), plus Route Compare / Fare Heatmap / My Train
# Dashboard (thin wrappers over real railway_api calls, right here).
# =============================================================================
class PlatformPredictRequest(BaseModel):
    train_number: str
    station: str


@app.post("/api/advanced/platform-predict")
def api_platform_predict(req: PlatformPredictRequest):
    return advanced_features.predict_platform(req.train_number, req.station)


# =============================================================================
# FEATURE 9: "Platform Finder" with Indoor Navigation
# =============================================================================
class PlatformNavigateRequest(BaseModel):
    station: str
    platform_number: Optional[int] = None
    train_number: Optional[str] = None       # used to predict the platform when platform_number isn't given
    entry_point: Optional[str] = None        # e.g. "Main entrance", "City side gate", "Parking side"


@app.post("/api/advanced/platform-navigate")
def api_platform_navigate(req: PlatformNavigateRequest):
    platform_number = req.platform_number
    predicted = None
    if platform_number is None and req.train_number:
        predicted = advanced_features.predict_platform(req.train_number, req.station)
        platform_number = predicted.get("predicted_platform")
    if platform_number is None:
        platform_number = 1
    guide = advanced_features.platform_navigation_guide(req.station, platform_number, req.entry_point)
    if predicted:
        guide["platform_source"] = "predicted_from_train_number"
        guide["platform_predict_confidence"] = predicted.get("confidence")
    else:
        guide["platform_source"] = "user_given"
    return guide


class PantryMenuRequest(BaseModel):
    train_number: str


@app.post("/api/advanced/pantry-menu")
def api_pantry_menu(req: PantryMenuRequest):
    train_name = None
    try:
        info = railway_api.get_train_info(req.train_number)
        payload = info.get("data", info) if isinstance(info, dict) else {}
        train_name = payload.get("trainName") or payload.get("train_name") or payload.get("name")
    except railway_api.RailwayAPIError:
        pass
    return advanced_features.pantry_menu(req.train_number, train_name)


@app.get("/api/advanced/station-amenities/{station_code}")
def api_station_amenities(station_code: str):
    return advanced_features.station_amenities(station_code)


# =============================================================================
# FEATURE: "Station Navigator" — Point of Interest Finder
# =============================================================================
@app.get("/api/advanced/station-navigator/{station_code}")
def api_station_navigator(station_code: str):
    return advanced_features.station_navigator(station_code)


@app.get("/api/advanced/coach-layout/{travel_class}")
def api_coach_layout(
    travel_class: str, train_number: Optional[str] = None,
    source: Optional[str] = None, dest: Optional[str] = None,
    date: Optional[str] = None, quota: Optional[str] = "GN",
):
    result = advanced_features.coach_layout(travel_class)
    if train_number:
        result["train_number"] = train_number
        try:
            info = railway_api.get_train_info(train_number)
            payload = info.get("data", info) if isinstance(info, dict) else {}
            result["train_name"] = payload.get("trainName") or payload.get("train_name") or payload.get("name")
        except railway_api.RailwayAPIError as e:
            result["train_name"] = None
            result["train_lookup_error"] = str(e)

    # FEATURE: seat/berth occupancy estimate (crowd-position follow-up —
    # see advanced_features.estimate_seat_occupancy's own docstring for
    # why this is a probabilistic shading of the real aggregate count,
    # not live per-berth truth). Only attempted when there's enough real
    # context to fetch a real availability count in the first place.
    if train_number and source and dest and date:
        source_code = _resolve_station_code(source)
        dest_code = _resolve_station_code(dest)
        if source_code and dest_code:
            try:
                avail = railway_api.get_seat_availability(
                    train_number, source_code, dest_code, date, travel_class, (quota or "GN").upper(),
                )
                status_text = advanced_features.extract_status_text(avail, date)
                result["occupancy_estimate"] = advanced_features.estimate_seat_occupancy(
                    travel_class, status_text, seed=f"{train_number}:{source_code}:{dest_code}:{date}:{quota}",
                )
            except railway_api.RailwayAPIError as e:
                result["occupancy_estimate"] = None
                result["occupancy_estimate_error"] = str(e)
    return result


# =============================================================================
# FEATURE: Coach & Seat "Find My Coach" Guide
# =============================================================================
class FindMyCoachRequest(BaseModel):
    coach_number: str                       # e.g. "S4", "B2", "A1", "HA1"
    train_number: Optional[str] = None      # used only to seed the deterministic end-guess, never a real lookup
    total_coaches_hint: Optional[int] = None  # override the typical-count table if the rider knows the real count


@app.post("/api/advanced/find-my-coach")
def api_find_my_coach(req: FindMyCoachRequest):
    return advanced_features.find_my_coach(req.coach_number, req.total_coaches_hint, req.train_number)


class TripProfile(BaseModel):
    """FEATURE 2: Best Seat/Berth Automatic Recommendation Based on Trip
    Profile. All fields optional — give whichever ones you actually know;
    see advanced_features._berth_recommendation_from_trip_profile for how
    each is used."""
    departure_time: Optional[str] = None   # "HH:MM", 24-hour
    arrival_time: Optional[str] = None     # "HH:MM", 24-hour
    duration_hours: Optional[float] = None  # overrides departure/arrival-derived duration if given directly
    overnight: Optional[bool] = None        # force-flag if you already know it spans sleeping hours
    travelers: Optional[str] = None         # solo | family | with_children | senior
    age: Optional[float] = None


class SeatRecommendRequest(BaseModel):
    travel_class: str
    preferences: List[str] = []
    trip_profile: Optional[TripProfile] = None


@app.post("/api/advanced/seat-recommend")
def api_seat_recommend(req: SeatRecommendRequest):
    profile_dict = req.trip_profile.dict() if req.trip_profile else None
    return advanced_features.seat_recommend(req.travel_class, req.preferences, profile_dict)


class RefundEstimateRequest(BaseModel):
    fare_amount: float
    travel_class: Optional[str] = "SL"
    ticket_status: Optional[str] = "confirmed"     # confirmed | rac | waitlist
    hours_before_departure: Optional[float] = None


@app.post("/api/advanced/refund-estimate")
def api_refund_estimate(req: RefundEstimateRequest):
    return advanced_features.estimate_refund(
        req.fare_amount, req.travel_class, req.ticket_status, req.hours_before_departure
    )


class RouteCompareRequest(BaseModel):
    train_numbers: List[str]           # 2 (or more) train numbers to compare
    source: str
    dest: str
    date: str                          # dd-mm-yyyy
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"


@app.post("/api/advanced/route-compare")
def api_route_compare(req: RouteCompareRequest):
    """Real fare + seat-availability comparison across 2+ trains for the
    same source/dest/date/class, pulled live from RailKit for each train."""
    results = []
    for train_number in req.train_numbers[:4]:
        entry = {"train_number": train_number}
        try:
            info = railway_api.get_train_info(train_number)
            payload = info.get("data", info) if isinstance(info, dict) else {}
            entry["train_name"] = payload.get("trainName") or payload.get("train_name")
        except railway_api.RailwayAPIError as e:
            entry["train_name"] = None
            entry["info_error"] = str(e)

        try:
            avail = railway_api.get_seat_availability(
                train_number, req.source, req.dest, req.date, req.travel_class, req.quota
            )
            entry["availability_status"] = advanced_features.extract_status_text(avail, req.date)
        except railway_api.RailwayAPIError as e:
            entry["availability_status"] = None
            entry["availability_error"] = str(e)

        try:
            fare = railway_api.get_fare(train_number, req.source, req.dest, req.date, req.travel_class, req.quota)
            entry["fare"] = advanced_features.extract_fare_amount(fare)
        except railway_api.RailwayAPIError as e:
            entry["fare"] = None
            entry["fare_error"] = str(e)

        results.append(entry)
    return {"source": req.source, "dest": req.dest, "date": req.date, "travel_class": req.travel_class, "results": results}


class FareHeatmapRequest(BaseModel):
    train_number: str
    source: str
    dest: str
    start_date: str                    # dd-mm-yyyy
    days: Optional[int] = 7            # capped at 10 to bound live calls
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"


@app.post("/api/advanced/fare-heatmap")
def api_fare_heatmap(req: FareHeatmapRequest):
    """Real per-day availability/fare grid for one train/route/class over
    a short date range, pulled live from RailKit (one call per day)."""
    try:
        start = datetime.strptime(req.start_date, "%d-%m-%Y")
    except ValueError:
        return {"error": "start_date must be DD-MM-YYYY.", "cells": []}

    days = max(1, min(req.days or 7, 10))
    cells = []
    for i in range(days):
        day = start + timedelta(days=i)
        day_str = day.strftime("%d-%m-%Y")
        cell = {"date": day_str, "weekday": day.strftime("%a")}
        try:
            avail = railway_api.get_seat_availability(
                req.train_number, req.source, req.dest, day_str, req.travel_class, req.quota
            )
            cell["status_text"] = advanced_features.extract_status_text(avail, day_str)
        except railway_api.RailwayAPIError as e:
            cell["status_text"] = None
            cell["error"] = str(e)
        try:
            fare = railway_api.get_fare(req.train_number, req.source, req.dest, day_str, req.travel_class, req.quota)
            cell["fare"] = advanced_features.extract_fare_amount(fare)
        except railway_api.RailwayAPIError:
            cell["fare"] = None
        cells.append(cell)
    return {"train_number": req.train_number, "source": req.source, "dest": req.dest, "travel_class": req.travel_class, "cells": cells}


# =============================================================================
# FEATURE: "Optimal Booking Window" Predictor
# =============================================================================
class BookingWindowRequest(BaseModel):
    train_number: str
    source: str
    dest: str
    date: Optional[str] = None            # dd-mm-yyyy
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"


@app.post("/api/advanced/booking-window")
def api_booking_window(req: BookingWindowRequest):
    status_kind, status_count = None, None
    source_code = _resolve_station_code(req.source)
    dest_code = _resolve_station_code(req.dest)
    if source_code and dest_code and req.date:
        try:
            avail = railway_api.get_seat_availability(
                req.train_number, source_code, dest_code, req.date, req.travel_class, (req.quota or "GN").upper(),
            )
            status_text = advanced_features.extract_status_text(avail, req.date)
            parsed = advanced_features.parse_availability_count(status_text)
            if parsed:
                status_kind, status_count = parsed["kind"], parsed["count"]
        except railway_api.RailwayAPIError:
            pass

    # Real crowd-prediction scores logged for THIS train so far this server
    # session (analytics.py) — see analytics.summary()'s crowd_series, just
    # filtered down to one train instead of every train.
    crowd_history = analytics.train_crowd_history(req.train_number)

    result = advanced_features.booking_window_advice(
        req.travel_class, req.date, status_kind, status_count, crowd_history,
    )
    result["train_number"] = req.train_number
    result["source"], result["dest"] = source_code, dest_code
    return result


class MyTrainEntry(BaseModel):
    train_number: str
    date: Optional[str] = None         # dd-mm-yyyy
    label: Optional[str] = None


class MyTrainDashboardRequest(BaseModel):
    trains: List[MyTrainEntry]


@app.post("/api/advanced/dashboard")
def api_my_train_dashboard(req: MyTrainDashboardRequest):
    """Batch live-status summary for a user's saved list of upcoming
    journeys (the list itself is kept client-side; this just refreshes
    real status for each entry in one call)."""
    out = []
    for entry in req.trains[:8]:
        row = {"train_number": entry.train_number, "label": entry.label, "date": entry.date}
        try:
            live = railway_api.get_live_train_status(entry.train_number, entry.date)
            train_info = None
            try:
                train_info = railway_api.get_train_info(entry.train_number)
            except railway_api.RailwayAPIError:
                pass
            position = gps_tracking.parse_live_position(entry.train_number, live, train_info)
            row.update({
                "current_station": position.current_station_name,
                "delay_minutes": position.delay_minutes,
                "status_source": position.position_source,
            })
        except railway_api.RailwayAPIError as e:
            row["error"] = str(e)
        out.append(row)
    return {"trains": out}


# =============================================================================
# FEATURE: Interactive Journey Timeline (Gantt view) — reuses the same
# full stop-by-stop timeline the live-tracking feature already builds
# (gps_tracking.get_full_timeline), just exposed as its own endpoint so
# "More Tools" can show it for any train/date without opening full live
# tracking (which additionally needs the train to be currently running).
# =============================================================================
@app.get("/api/advanced/journey-timeline/{train_number}")
def api_journey_timeline(train_number: str, date: Optional[str] = None):
    try:
        stops = gps_tracking.get_full_timeline(train_number, date)
    except railway_api.RailwayAPIError as e:
        return {"train_number": train_number, "date": date, "stops": [], "error": str(e)}
    stops_json = gps_tracking.timeline_to_json(stops)
    return {
        "train_number": train_number,
        "date": date,
        "stops": stops_json,
        "error": None if stops_json else "No timeline data available for this train/date.",
    }


# =============================================================================
# FEATURE: Proactive Delay Alerts — the watchlist itself is kept client-
# side (same pattern as "My Trains"); this batch-checks real predicted
# delay for each watched train and flags which ones cross the person's
# own threshold. HONEST NOTE: this can only alert while the app/tab is
# open and this check is run (on load / periodic poll) - there is no
# push-notification infrastructure here, so this is in-app alerting, not
# a background push service.
# =============================================================================
class AlertWatch(BaseModel):
    train_number: str
    date: Optional[str] = None
    threshold_minutes: int = 15
    label: Optional[str] = None


class AlertsCheckRequest(BaseModel):
    watches: List[AlertWatch]


@app.post("/api/advanced/alerts/check")
def api_alerts_check(req: AlertsCheckRequest):
    out = []
    for w in req.watches[:8]:
        row = {"train_number": w.train_number, "label": w.label, "threshold_minutes": w.threshold_minutes}
        try:
            # FEATURE: label-aware — w.label is resolved against the
            # train's real live timeline (see _predict_for_watch_station),
            # same pipeline push notifications use, so the in-app tab and
            # a push notification never disagree about the same watch.
            result = _predict_for_watch_station(w.train_number, w.date, w.label)
            row["station_status"] = result["status"]
            row["station"] = result.get("station")
            row["message"] = result.get("message")
            if result["status"] == "already_reached":
                row["already_reached_at"] = result.get("actual_time")
                row["predicted_delay_minutes"] = None
                row["breached"] = False
            elif result["status"] == "predicted":
                delay = result.get("delay_minutes")
                row["predicted_delay_minutes"] = delay
                row["predicted_eta"] = result.get("predicted_eta")
                row["breached"] = delay is not None and delay >= w.threshold_minutes
                row["confidence"] = result.get("confidence")
            else:  # not_on_route / unavailable — no meaningful prediction to show
                row["predicted_delay_minutes"] = None
                row["breached"] = False
        except Exception as e:
            row["error"] = str(e)
            row["breached"] = False
        out.append(row)
    return {
        "watches": out,
        "note": "Checked just now — re-run this check (e.g. on a timer while this tab/screen is open) for updated alerts; there's no background push notification service behind this.",
    }


# =============================================================================
# FEATURE: Push Notifications for Proactive Alerts
# -----------------------------------------------------------------------
# Unlike the in-app check above, THIS watchlist is held server-side (see
# push_store.py) so alert_scheduler.py's background job can see it even
# when nobody has the app open. The frontend still keeps its own
# localStorage copy for instant UI rendering (same as before) and pushes
# the full list here whenever it changes — see push_store.replace_watches
# for why "replace everything" beats diffing add/remove calls.
# =============================================================================
class RegisterTokenRequest(BaseModel):
    token: str
    platform: Optional[str] = None  # "web" | "android" | "ios", informational only


@app.post("/api/push/register-token")
def api_push_register_token(req: RegisterTokenRequest):
    if not req.token.strip():
        return {"ok": False, "error": "Empty token."}
    push_store.register_token(req.token.strip(), req.platform)
    return {"ok": True, "push_configured": push_notifications.status()["configured"]}


class UnregisterTokenRequest(BaseModel):
    token: str


@app.post("/api/push/unregister")
def api_push_unregister(req: UnregisterTokenRequest):
    push_store.unregister_token(req.token.strip())
    return {"ok": True}


class PushWatch(BaseModel):
    train_number: str
    date: Optional[str] = None
    threshold_minutes: int = 15
    label: Optional[str] = None


class SyncWatchesRequest(BaseModel):
    token: str
    watches: List[PushWatch]


@app.post("/api/push/watches")
def api_push_sync_watches(req: SyncWatchesRequest):
    """Called whenever the frontend's local alert watchlist changes, so the
    background scheduler's copy stays in sync. Token must already be
    registered via /api/push/register-token (that call and this one
    happen together from the frontend, see app.js)."""
    push_store.replace_watches(req.token.strip(), [w.dict() for w in req.watches])
    return {"ok": True, "watch_count": len(req.watches[:8])}


@app.get("/api/push/status")
def api_push_status():
    """Diagnostics: whether Firebase is configured + how many devices/watches are registered."""
    return {**push_notifications.status(), **push_store.stats()}


# =============================================================================
# FEATURE: Fare & Availability "Alert Zone" — server-side watchlist (same
# device_tokens registered above via /api/push/register-token) so
# alert_scheduler.py's background fare-check pass can see it even when
# nobody has the app open. Mirrors /api/push/watches + /api/advanced/
# alerts/check's pairing: this endpoint persists the full watch set for
# background push, the on-demand endpoint below checks a client-held list
# right now for immediate UI feedback (same "two ways to trigger the same
# real pipeline" pattern as delay alerts).
# =============================================================================
class FareWatch(BaseModel):
    train_number: str
    source: str
    dest: str
    date: Optional[str] = None
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"
    threshold_pct: Optional[int] = 10
    label: Optional[str] = None
    baseline_fare: Optional[float] = None   # the real fare shown when this watch was created (Fare Heatmap/Search)


class SyncFareWatchesRequest(BaseModel):
    token: str
    watches: List[FareWatch]


@app.post("/api/push/fare-watches")
def api_push_sync_fare_watches(req: SyncFareWatchesRequest):
    """Called whenever the frontend's local fare-watchlist changes (e.g. the
    'Watch This Route' button in Fare Heatmap), so the background
    scheduler's copy stays in sync. Token must already be registered via
    /api/push/register-token."""
    push_store.replace_fare_watches(req.token.strip(), [w.dict() for w in req.watches])
    return {"ok": True, "watch_count": len(req.watches[:8])}


@app.get("/api/push/fare-watches")
def api_push_list_fare_watches(token: str):
    return {"watches": push_store.list_fare_watches_for_token(token.strip())}


def _fare_check_for_watch(train_number: str, source: str, dest: str, date: Optional[str], travel_class: str, quota: str) -> dict:
    """Real fare + availability check for one fare watch — the exact same
    railway_api calls the Fare Heatmap tool itself makes for one cell.
    Shared by both the on-demand check endpoint below and (via app.py's
    startup wiring) alert_scheduler.run_fare_check_once's background pass,
    so there's one real pipeline, not two diverging ones."""
    out = {"fare": None, "status_text": None, "status_kind": None, "status_count": None}
    try:
        avail = railway_api.get_seat_availability(train_number, source, dest, date, travel_class, quota)
        out["status_text"] = advanced_features.extract_status_text(avail, date)
        parsed = advanced_features.parse_availability_count(out["status_text"])
        if parsed:
            out["status_kind"], out["status_count"] = parsed["kind"], parsed["count"]
    except railway_api.RailwayAPIError as e:
        out["status_error"] = str(e)
    try:
        fare = railway_api.get_fare(train_number, source, dest, date, travel_class, quota)
        out["fare"] = advanced_features.extract_fare_amount(fare)
    except railway_api.RailwayAPIError as e:
        out["fare_error"] = str(e)
    return out


class FareWatchCheckRequest(BaseModel):
    watches: List[FareWatch]


@app.post("/api/advanced/fare-watch/check")
def api_fare_watch_check(req: FareWatchCheckRequest):
    """On-demand check of a CLIENT-HELD fare watchlist (same pattern as
    /api/advanced/alerts/check for delay watches) — for immediate UI
    feedback when the Alert Zone tab is open, independent of whether these
    watches are also registered server-side for background push."""
    out = []
    for w in req.watches[:8]:
        source_code = _resolve_station_code(w.source) or w.source.strip().upper()
        dest_code = _resolve_station_code(w.dest) or w.dest.strip().upper()
        row = {
            "train_number": w.train_number, "label": w.label, "source": source_code, "dest": dest_code,
            "travel_class": w.travel_class, "date": w.date, "baseline_fare": w.baseline_fare,
        }
        result = _fare_check_for_watch(w.train_number, source_code, dest_code, w.date, w.travel_class or "SL", (w.quota or "GN").upper())
        row.update(result)
        drop_pct = None
        if w.baseline_fare and result.get("fare") is not None:
            drop_pct = round(100.0 * (w.baseline_fare - result["fare"]) / w.baseline_fare, 1)
        row["fare_drop_pct"] = drop_pct
        row["breached"] = (drop_pct is not None and drop_pct >= (w.threshold_pct or 10)) or result.get("status_kind") == "AVAILABLE"
        out.append(row)
    return {
        "watches": out,
        "note": "Checked just now — re-run this check (e.g. on a timer while this tab/screen is open) for updated alerts; "
                "register for push (above) to also get notified in the background.",
    }


# =============================================================================
# FEATURE: Background-surviving Smart Alarm — server-side watchlist (same
# device_tokens registered above) so alert_scheduler.py's background job
# (and the live-tracking websocket trigger, see check_and_push_alarm_for_train
# in ws_track_train) can fire the arrival alarm via push even after the tab/
# app that armed it is fully closed — the in-tab version (ltAlarmForm in
# app.js) only works while that tab stays open/backgrounded. Mirrors
# /api/push/fare-watches' "replace the full client-held set" pairing.
# =============================================================================
class AlarmWatch(BaseModel):
    train_number: str
    station: str
    date: Optional[str] = None
    lead_minutes: Optional[float] = 10
    label: Optional[str] = None


class SyncAlarmWatchesRequest(BaseModel):
    token: str
    watches: List[AlarmWatch]


@app.post("/api/push/alarms")
def api_push_sync_alarms(req: SyncAlarmWatchesRequest):
    """Called whenever the frontend's local Smart Alarm arm/disarm state
    changes, so the background scheduler's copy stays in sync. Token must
    already be registered via /api/push/register-token."""
    push_store.replace_alarm_watches(req.token.strip(), [w.dict() for w in req.watches])
    return {"ok": True, "watch_count": len(req.watches[:8])}


@app.get("/api/push/alarms")
def api_push_list_alarms(token: str):
    return {"watches": push_store.list_alarm_watches_for_token(token.strip())}


# =============================================================================
# FEATURE: Connection-Risk Alert — cross-references a currently-tracked
# train's real arrival at an interchange station against a connecting
# train's real departure from that same station (see connection_risk.py).
# =============================================================================
class ConnectionRiskRequest(BaseModel):
    primary_train_number: str
    primary_date: Optional[str] = None
    interchange_station: str
    connecting_train_number: str
    connecting_date: Optional[str] = None
    connecting_boarding_station: Optional[str] = None  # defaults to interchange_station


@app.post("/api/advanced/connection-risk")
def api_connection_risk(req: ConnectionRiskRequest):
    primary_timeline, _ = _fetch_timeline_with_predictions(req.primary_train_number, req.primary_date)
    connecting_timeline, _ = _fetch_timeline_with_predictions(
        req.connecting_train_number, req.connecting_date or req.primary_date,
    )
    if not primary_timeline or not connecting_timeline:
        return {
            "found": False,
            "note": "Couldn't fetch a live timeline for one or both trains right now — try again shortly.",
        }
    primary_entry = _match_station_in_timeline(primary_timeline, req.interchange_station)
    boarding_label = req.connecting_boarding_station or req.interchange_station
    connecting_entry = _match_station_in_timeline(connecting_timeline, boarding_label)
    station_display = (primary_entry or {}).get("name") or req.interchange_station
    risk = connection_risk.evaluate(
        primary_entry, connecting_entry, req.primary_train_number, req.connecting_train_number, station_display,
    )
    return connection_risk.to_dict(risk)


# =============================================================================
# FEATURE: Real-Time Per-Coach Crowding (passenger-reported) — see
# coach_crowd_store.py. Distinct from /api/crowd/predict (booking-data
# heuristic, whole-train) and the Coach Layout tool's static occupancy
# estimate — this is a live, rider-submitted signal per coach.
# =============================================================================
class CoachCrowdReportRequest(BaseModel):
    train_number: str
    coach: str
    crowd_level: str  # one of coach_crowd_store.CROWD_LEVELS
    date: Optional[str] = None
    reporter_id: Optional[str] = None


@app.post("/api/coach-crowd/report")
def api_coach_crowd_report(req: CoachCrowdReportRequest):
    return coach_crowd_store.submit_report(req.train_number, req.coach, req.crowd_level, req.date, req.reporter_id)


@app.get("/api/coach-crowd/{train_number}")
def api_coach_crowd_get(train_number: str, max_age_minutes: int = 20):
    return coach_crowd_store.aggregate_for_train(train_number, max_age_seconds=max(60, max_age_minutes * 60))


# =============================================================================
# FEATURE: End-of-Trip Summary Card (shareable) — see public_share.py. The
# frontend/mobile computes the summary itself from the SAME per-station
# figures already shown live during tracking (nothing recomputed here) and
# just asks this endpoint to snapshot + hand back a shareable id/url.
# =============================================================================
class TripSummaryRequest(BaseModel):
    train_number: str
    date: Optional[str] = None
    summary: dict


@app.post("/api/trip-summary")
def api_trip_summary_save(req: TripSummaryRequest):
    share_id = public_share.save_summary(req.train_number, req.date, req.summary)
    return {"ok": True, "share_id": share_id, "url": f"/trip/{share_id}"}


@app.get("/api/trip-summary/{share_id}")
def api_trip_summary_get(share_id: str):
    row = public_share.get_summary(share_id)
    if not row:
        return {"found": False}
    return {"found": True, **row}


# =============================================================================
# FEATURE: Live Station Crowd Estimation
# =============================================================================
@app.get("/api/advanced/station-crowd/{station_code}")
def api_station_crowd(station_code: str, hours: int = 2):
    hours = 2 if hours not in (2, 4, 8) else hours
    try:
        data = railway_api.get_live_at_station(station_code, hours)
        train_count = advanced_features.extract_station_train_count(data)
    except railway_api.RailwayAPIError as e:
        return {"station": station_code, "error": str(e)}
    current_hour = datetime.now().hour
    return advanced_features.estimate_station_crowd(station_code, train_count, hours, current_hour)


# =============================================================================
# FEATURE: Smart Luggage/Parcel Tracking — see advanced_features.py for
# why this is informational (official portal link) rather than fake
# tracking data.
# =============================================================================
@app.get("/api/advanced/parcel-info")
def api_parcel_info():
    return advanced_features.parcel_info()


# =============================================================================
# FEATURE: Offline Route Maps & Station Information — bulk export of the
# curated station coordinates + amenities for the frontend to cache
# locally (localStorage/AsyncStorage) once, then look up without a
# network call. Now all ~8,700 Indian Railways stations (~600KB JSON) —
# a bigger one-time download than the old ~51-station bundle, but still a
# single fetch-once-and-cache call, and it's what makes offline lookup
# actually cover the whole country instead of just the majors.
# =============================================================================
@app.get("/api/advanced/offline-stations")
def api_offline_stations():
    return {"stations": advanced_features.offline_station_bundle(station_search._STATION_COORDS)}


# =============================================================================
# FEATURE: Full Offline Knowledge Base (RAG Without Network)
# -----------------------------------------------------------------------
# Same bundle-once-then-cache-locally pattern as Offline Stations above,
# applied to the RAG pipeline's own knowledge_base.json (54 real, human-
# written policy/FAQ articles — the exact same corpus the online
# hybrid/semantic retrieval already searches). Once downloaded, the
# frontend/mobile can plain-keyword-search this bundle with zero network.
#
# HONESTY LIMIT, stated plainly here and surfaced in the response: this is
# real content search, not full offline RAG. The embeddings model
# (semantic_engine.py) and the LLM synthesis step (Gemini/Anthropic) that
# turn retrieved chunks into a natural-language answer both need a live
# call — there's no offline embeddings/LLM runtime in this project. What
# you get offline is the same real article text, found by simple keyword
# matching instead of semantic search, with no generated prose wrapped
# around it.
# =============================================================================
@app.get("/api/advanced/offline-knowledge-base")
def api_offline_knowledge_base():
    try:
        with open(rag_engine.KB_PATH, "r", encoding="utf-8") as f:
            articles = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return {"articles": [], "error": f"Couldn't load the knowledge base: {e}"}
    return {
        "articles": articles,
        "article_count": len(articles),
        "note": (
            "Real KB articles (the same ones the online RAG searches), for offline plain-keyword "
            "lookup only — no semantic search and no LLM-written answer without a live connection."
        ),
    }


# =============================================================================
# FEATURE: Real-Time Delay Dashboard with Historical Patterns
# -----------------------------------------------------------------------
# See historical_delay.py — real per-day completed-journey history for
# this train, grouped by weekday. A day with no real data stays marked
# unavailable rather than averaged in as zero delay.
# =============================================================================
@app.get("/api/advanced/delay-history/{train_number}")
def api_delay_history(train_number: str, days: int = 14):
    return historical_delay.get_historical_pattern(train_number, days)


# =============================================================================
# FEATURE: PNR Auto-Tracking & Status Change Alerts
# -----------------------------------------------------------------------
# See pnr_tracking.py. Single structured lookup + a batch watchlist-check
# endpoint (client holds the watchlist and its last-seen status, same
# pattern as the existing Delay Alerts tool — in-app checking on open/
# refresh, not a real background push; that needs EAS Build + the user's
# own FCM/APNs credentials, which this project doesn't have).
# =============================================================================
@app.get("/api/pnr/status/{pnr}")
def api_pnr_status(pnr: str):
    try:
        data = railway_api.get_pnr_status(pnr)
    except railway_api.RailwayAPIError as e:
        return {"pnr": pnr, "error": str(e), "raw_available": False}
    summary = pnr_tracking.extract_pnr_summary(pnr, data)
    return pnr_tracking.pnr_summary_to_dict(summary)


class PNRWatchEntry(BaseModel):
    pnr: str
    last_known_status: Optional[str] = None
    label: Optional[str] = None


class PNRWatchlistRequest(BaseModel):
    entries: List[PNRWatchEntry]


@app.post("/api/pnr/watchlist/check")
def api_pnr_watchlist_check(req: PNRWatchlistRequest):
    def _fetch(pnr: str) -> dict:
        return railway_api.get_pnr_status(pnr)
    rows = pnr_tracking.check_pnr_watchlist([e.dict() for e in req.entries], _fetch)
    return {"results": rows}


# =============================================================================
# FEATURE: Personalized Travel Assistant (Profile & History) — the trip
# history itself is kept CLIENT-SIDE (same pattern as My Trains/Delay
# Alerts elsewhere in this file); these endpoints do the real-time lookups
# that history-only math can't (live crowd/delay/alternatives).
# =============================================================================
class ProfileTrip(BaseModel):
    source: str
    dest: str
    travel_class: Optional[str] = None
    date: Optional[str] = None  # dd-mm-yyyy


class ProfileSummaryRequest(BaseModel):
    history: List[ProfileTrip]


@app.post("/api/advanced/profile/summary")
def api_profile_summary(req: ProfileSummaryRequest):
    return advanced_features.summarize_travel_history([t.dict() for t in req.history])


def _crowd_for_train(train_number: str, source: str, dest: str, date: str, travel_class: str, quota: str) -> dict:
    seat_data, seat_error = None, None
    try:
        seat_data = railway_api.get_seat_availability(train_number, source, dest, date, travel_class, quota)
    except railway_api.RailwayAPIError as e:
        seat_error = str(e)
    pred = crowd_prediction.predict_crowd(seat_availability_data=seat_data, travel_class=travel_class, date_ddmmyyyy=date)
    return {"train_number": train_number, "level": pred.level, "score": pred.score, "seat_data_error": seat_error}


class PackedCheckRequest(BaseModel):
    train_number: str
    source: str
    dest: str
    date: str
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"


@app.post("/api/advanced/profile/packed-check")
def api_packed_check(req: PackedCheckRequest):
    """'Packed?' — real crowd estimate for the person's usual train, plus
    up to 3 real alternative trains on the same route/date/class ranked by
    the same crowd signal, so a high estimate comes with an actual way out
    rather than just a warning."""
    travel_class = (req.travel_class or "SL").upper()
    quota = (req.quota or "GN").upper()
    main = _crowd_for_train(req.train_number, req.source, req.dest, req.date, travel_class, quota)

    alternatives = []
    try:
        source_code = _resolve_station_code(req.source)
        dest_code = _resolve_station_code(req.dest)
        if source_code and dest_code:
            live_data = railway_api.search_trains_between_stations(source_code, dest_code, req.date)
            trains = trains_between.parse_trains_list(live_data)
            trains, _ = trains_between.filter_by_class(trains, travel_class)
            candidates = [t for t in trains if t.train_number != req.train_number][:3]
            for t in candidates:
                alternatives.append(_crowd_for_train(t.train_number, req.source, req.dest, req.date, travel_class, quota))
    except railway_api.RailwayAPIError:
        pass  # main crowd result still stands even if alternatives can't be fetched

    alternatives.sort(key=lambda a: a["score"])
    return {
        "your_train": main,
        "alternatives": alternatives,
        "note": "Alternatives are other trains on this exact route/date/class, ranked by the same live crowd signal.",
    }


class AlternativePlanRequest(BaseModel):
    train_number: str
    source: str
    dest: str
    date: str
    travel_class: Optional[str] = "SL"
    quota: Optional[str] = "GN"
    delay_threshold_minutes: Optional[int] = 20


@app.post("/api/advanced/profile/alternative-plan")
def api_alternative_plan(req: AlternativePlanRequest):
    """'Alternative travel plan' — checks the REAL predicted delay for the
    person's train; if it crosses their threshold, finds real alternative
    trains on the same route/date/class and ranks them by live crowd +
    whether they show real availability, so this is an actual plan B, not
    just a delay warning."""
    travel_class = (req.travel_class or "SL").upper()
    quota = (req.quota or "GN").upper()
    threshold = req.delay_threshold_minutes or 20

    pred = api_delay_predict(DelayPredictRequest(train_number=req.train_number, date=req.date, source=req.source))
    predicted_delay = pred.get("predicted_delay_minutes")
    breached = predicted_delay is not None and predicted_delay >= threshold

    result = {
        "train_number": req.train_number,
        "predicted_delay_minutes": predicted_delay,
        "threshold_minutes": threshold,
        "delayed_beyond_threshold": breached,
        "alternatives": [],
    }
    if not breached:
        result["note"] = "No alternative needed — predicted delay is under your threshold."
        return result

    try:
        source_code = _resolve_station_code(req.source)
        dest_code = _resolve_station_code(req.dest)
        if not source_code or not dest_code:
            raise railway_api.RailwayAPIError(f"Couldn't recognize station \"{req.source if not source_code else req.dest}\".")
        live_data = railway_api.search_trains_between_stations(source_code, dest_code, req.date)
        trains = trains_between.parse_trains_list(live_data)
        trains, _ = trains_between.filter_by_class(trains, travel_class)
        candidates = [t for t in trains if t.train_number != req.train_number][:3]
        for t in candidates:
            entry = _crowd_for_train(t.train_number, req.source, req.dest, req.date, travel_class, quota)
            try:
                avail = railway_api.get_seat_availability(t.train_number, req.source, req.dest, req.date, travel_class, quota)
                entry["availability_status"] = advanced_features.extract_status_text(avail, req.date)
            except railway_api.RailwayAPIError:
                entry["availability_status"] = None
            entry["train_name"] = t.train_name
            entry["departure"] = t.source_departure
            result["alternatives"].append(entry)
        result["alternatives"].sort(key=lambda a: a["score"])
        result["note"] = f"Predicted delay ({predicted_delay}m) crosses your {threshold}m threshold — here are other trains on this route/date/class."
    except railway_api.RailwayAPIError as e:
        result["note"] = f"Delay crosses your threshold, but couldn't fetch alternatives right now: {e}"
    return result


# =============================================================================
# FEATURE: "Near Me" Real-Time Platform Information — trains currently due
# at a station, which platforms are actually reported occupied (only ever
# from the provider's own reported platform field - see advanced_features
# for why this never guesses), and the next train due to arrive.
# =============================================================================
@app.get("/api/advanced/station-now/{station_code}")
def api_station_now(station_code: str, hours: int = 2):
    hours = 2 if hours not in (2, 4, 8) else hours
    try:
        data = railway_api.get_live_at_station(station_code, hours)
    except railway_api.RailwayAPIError as e:
        return {"station": station_code, "error": str(e)}
    trains = advanced_features.parse_station_live_trains(data)
    return {
        "station": station_code,
        "hours_window": hours,
        "trains": trains,
        "next_arrival": advanced_features.next_arrival(trains),
        "platform_heatmap": advanced_features.build_platform_heatmap(trains),
        "error": None if trains else "No trains reported for this station/window right now.",
    }


# =============================================================================
# FEATURE: Real-Time Train Position via WebSockets
# =============================================================================
@app.websocket("/ws/track/{train_number}")
async def ws_track_train(websocket: WebSocket, train_number: str):
    """
    Streams live position updates for a train every _TRACK_POLL_INTERVAL_SECONDS
    without the client having to re-poll `/api/chat`. Each fetch goes through
    the SAME cached railway_api calls (get_live_train_status / get_train_info)
    used by the regular chat flow — the cache TTLs there (120s / 24h) mean this
    doesn't hammer the provider even with several tabs open, it just serves
    the already-cached response between real refreshes.

    Optional query params (all optional — the feed still works with none of
    them, it just has less to work with):
      - date (DD-MM-YYYY): which day's running status to track. Defaults to
        today (see railway_api.get_live_train_status) if omitted.
      - source, dest, travel_class, quota: when source AND dest are both
        given, this pulls REAL seat-availability data from RailKit for that
        train/route/date/class and runs a proper booking-demand-driven crowd
        prediction (same logic as /api/crowd/predict) alongside the position
        and delay prediction. Without them, crowd prediction still runs —
        just on date/time/class heuristics only, same as crowd_prediction.py
        does whenever real booking data isn't available — and says so
        plainly in `crowd_basis` rather than pretending otherwise.
    """
    await websocket.accept()
    q = websocket.query_params
    date_ddmmyyyy = (q.get("date") or "").strip() or None
    source = (q.get("source") or "").strip().upper() or None
    dest = (q.get("dest") or "").strip().upper() or None
    travel_class = (q.get("travel_class") or "SL").strip().upper()
    quota = (q.get("quota") or "GN").strip().upper()
    # FEATURE: Dynamic Re-route Suggestions During Live Tracking — how many
    # minutes late (predicted, falling back to reported) counts as "severe"
    # enough to proactively suggest getting off at the next junction. See
    # reroute_suggestions.py. Overridable per connection; defaults to the
    # module's own documented default.
    try:
        reroute_threshold_minutes = int(q.get("reroute_threshold_minutes") or reroute_suggestions.SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT)
    except (TypeError, ValueError):
        reroute_threshold_minutes = reroute_suggestions.SEVERE_DELAY_THRESHOLD_MINUTES_DEFAULT

    # FEATURE: instant speed per GPS ping + recency-weighted smoothing.
    # State lives for the lifetime of THIS connection only (plain locals
    # in the polling loop) - a fresh connection has no real prior sample
    # to diff against, so it starts clean rather than reusing another
    # session's numbers.
    prev_position_distance_km = None
    prev_position_timestamp = None
    speed_tracker = gps_tracking.RecencyWeightedSpeed(halflife_seconds=45.0, max_samples=12)
    # FEATURE: direction-aware smoothing for the headline predicted-delay
    # figure (see gps_tracking.DirectionAwareSmoother) - reacts fast when
    # the train is genuinely recovering time (delay dropping), stays
    # damped against single-poll noise or a slow worsening trend
    # otherwise. Replaces the earlier symmetric smoother, which fixed the
    # random-looking jumpiness (7/10/12/14/15/16/5/6) but could lag behind
    # a real recovery in progress (reported: predicted 30 min, actual 25 -
    # an over-prediction consistent with lagging behind a real drop).
    delay_tracker = gps_tracking.DirectionAwareSmoother(halflife_down_seconds=30.0, halflife_up_seconds=90.0)
    # FEATURE: Route-Deviation/Diversion Detection — see route_deviation.py.
    # Lives for the lifetime of THIS connection only, same reasoning as the
    # trackers above: a fresh connection has no prior "how long has this
    # been off-route" streak to carry over.
    deviation_tracker = route_deviation.DeviationSustainTracker()
    # FEATURE: near-instant "current station" updates on a real arrival.
    # RailKit's own live-status is cache-backed (see get_live_train_status)
    # so it wouldn't normally refresh mid-TTL even if the train just pulled
    # in. Set to True at the end of a poll where RailRadar's real segment
    # progress shows the train essentially AT the next station (>=97%
    # of the way there) or its own predicted ETA implies arrival within
    # this poll interval - consumed at the START of the NEXT poll to force
    # a real, uncached RailKit fetch right when the station change is
    # actually expected, instead of waiting out the rest of the cache TTL.
    force_refresh_next_poll = False

    try:
        while True:
            payload = {"type": "position_update", "train_number": train_number, "date": date_ddmmyyyy}

            # FEATURE: Train Capacity & Crowd Prediction, folded into the
            # live-tracking feed — computed INDEPENDENTLY of the position/
            # live-status fetch below, since it only needs seat-availability
            # data. A live-status outage should never also take down the
            # crowd score. Real seat-availability data when a source/dest is
            # given, heuristics-only otherwise, but ALWAYS with the full
            # basis/disclaimer explanation, never a bare number.
            crowd_date = date_ddmmyyyy or datetime.now().strftime("%d-%m-%Y")
            seat_error = None
            seat_data = None
            if source and dest:
                try:
                    seat_data = await asyncio.to_thread(
                        railway_api.get_seat_availability, train_number, source, dest, crowd_date, travel_class, quota,
                    )
                except railway_api.RailwayAPIError as e:
                    seat_error = str(e)
            crowd_pred = crowd_prediction.predict_crowd(
                seat_availability_data=seat_data, travel_class=travel_class, date_ddmmyyyy=crowd_date,
                time_hhmm=datetime.now().strftime("%H:%M"),
            )
            payload.update({
                "crowd_level": crowd_pred.level,
                "crowd_score": crowd_pred.score,
                "crowd_basis": crowd_pred.basis,
                "crowd_disclaimer": crowd_pred.disclaimer,
                "crowd_seat_data_error": seat_error,
            })
            try:
                analytics.record_event(intent="crowd_prediction", train_number=train_number, crowd_score=crowd_pred.score)
            except Exception:
                pass

            try:
                # FEATURE: these two RailKit calls are independent (neither
                # needs the other's result) - run them concurrently via
                # asyncio.gather instead of one after another. Each is
                # individually cached (get_live_train_status: 45s,
                # get_train_info: 86400s) so most polls already serve from
                # cache near-instantly either way - the real win is on a
                # cache-cold poll (first poll of a session, or the ~45s
                # live-status refresh), where this halves the wall-clock
                # wait instead of paying both calls' latency back to back.
                # `_force_refresh` bypasses get_live_train_status's cache
                # for just this one call when the PREVIOUS poll's real
                # RailRadar segment progress showed the train essentially
                # at the next station - see the arrival-detection block
                # further down, which sets force_refresh_next_poll.
                this_poll_force_refresh = force_refresh_next_poll
                force_refresh_next_poll = False
                live_data, train_info_result = await asyncio.gather(
                    asyncio.to_thread(railway_api.get_live_train_status, train_number, date_ddmmyyyy, _force_refresh=this_poll_force_refresh),
                    asyncio.to_thread(railway_api.get_train_info, train_number),
                    return_exceptions=True,
                )
                if isinstance(live_data, BaseException):
                    raise live_data
                train_info_data = None if isinstance(train_info_result, BaseException) else train_info_result
                position = gps_tracking.parse_live_position(train_number, live_data, train_info_data)
                timeline_stops = gps_tracking.parse_full_timeline(live_data, train_info_data)
                distance_km, route_progress_ratio = _distance_and_progress_from_route(
                    train_info_data, source or position.current_station_code
                )

                # FEATURE: live weather at the train's current position —
                # real reading from WeatherAPI.com (see weather.py), cached
                # 15 min per ~1km-rounded lat/lng so this doesn't hammer the
                # weather API on every 5s poll. None (never a guess) if the
                # key isn't configured or the call fails. Fog/heavy-rain
                # readings also feed a bounded weather_component into the
                # delay predictions just below — the two biggest real
                # weather-driven delay causes on Indian Railways that the
                # model had no visibility into before this.
                current_weather = await asyncio.to_thread(weather.get_current_weather, position.lat, position.lng)
                weather_component_minutes, weather_basis = weather.weather_delay_component_minutes(current_weather)

                # Real crossed-station delay trend + average running speed
                # (e.g. "crossed VSKP +5, SLO +10, RJY +10, BZA +15 -> next
                # station KMT") - the two strongest real signals for what
                # happens at the NEXT station, on top of the current
                # snapshot delay figure alone.
                delay_trend = gps_tracking.compute_recent_delay_trend(timeline_stops)
                # Combines BOTH real providers (RailKit + RailRadar), then an
                # ML instant estimate only as a last resort - see
                # _resolve_avg_speed. Run off the event loop since it makes
                # its own (blocking) RailRadar calls.
                avg_speed_kmph, avg_speed_basis, avg_speed_source_ws = await asyncio.to_thread(
                    _resolve_avg_speed, train_number, timeline_stops, route_progress_ratio,
                    distance_km, date_ddmmyyyy, datetime.now().strftime("%H:%M"),
                    position.delay_minutes, delay_trend.get("trend_per_stop"),
                )
                # FEATURE: RailRadar's own per-station real actual/delay
                # data, fetched once per poll and handed to
                # _predict_delay_per_reporting_station below so an
                # "upcoming" station RailKit hasn't confirmed yet can still
                # show RailRadar's own real recorded time instead of this
                # app's model estimate — see that function's rr_by_code
                # note. _fetch_raw is cached 60s, so this is a cache hit on
                # most polls (poll interval is well under that), not a
                # fresh RailRadar call every ~5s. Off the event loop since
                # it's a blocking HTTP call; never raises (see
                # railradar_fallback's module docstring), but wrapped
                # anyway since this is best-effort and must never break
                # live tracking if it somehow does.
                try:
                    rr_stops = await asyncio.to_thread(railradar_fallback.fetch_railradar_timeline, train_number, date_ddmmyyyy)
                except Exception:
                    rr_stops = []

                try:
                    delay_pred = delay_prediction.predict_delay(
                        distance_km=distance_km, date_ddmmyyyy=date_ddmmyyyy,
                        route_progress_ratio=route_progress_ratio, current_delay_minutes=position.delay_minutes,
                        travel_class=travel_class,
                        recent_delay_trend_per_stop=delay_trend.get("trend_per_stop"),
                        recent_delay_basis=delay_trend.get("basis"),
                        avg_speed_kmph=avg_speed_kmph, avg_speed_basis=avg_speed_basis,
                    )
                    if delay_pred is not None and weather_component_minutes:
                        # Fold the real weather reading on top of the ML
                        # ensemble's own estimate — added, not blended, since
                        # it's an environmental factor the model had zero
                        # features for, not something it partially captured
                        # already. Basis is appended so the "Why" explainer
                        # is honest about where the extra minutes came from.
                        delay_pred.predicted_delay_minutes = max(0, delay_pred.predicted_delay_minutes + round(weather_component_minutes))
                        delay_pred.basis = list(delay_pred.basis) + [f"weather: {weather_basis}"]
                        delay_pred.low_minutes, delay_pred.high_minutes = delay_prediction._confidence_band(
                            delay_pred.predicted_delay_minutes, delay_pred.confidence
                        )
                except Exception:
                    delay_pred = None

                # BUGFIX/FEATURE: smooth the headline predicted-delay figure
                # across polls (see gps_tracking.RecencyWeightedValue) -
                # reported jumping 7/10/12/14/15/16/5/6 min poll to poll,
                # out of sequence, even though the confidence interval kept
                # correctly bracketing the real delay throughout. The RAW
                # per-poll value still feeds the tracker every time (so a
                # genuine sustained change is still caught within a couple
                # of polls), but what's DISPLAYED and put in the band is
                # the smoothed trend, not every individual noisy reading.
                if delay_pred is not None:
                    delay_tracker.add(delay_pred.predicted_delay_minutes, datetime.now())
                    smoothed = delay_tracker.value()
                    if smoothed is not None:
                        delay_pred.predicted_delay_minutes = round(smoothed)
                        delay_pred.low_minutes, delay_pred.high_minutes = delay_prediction._confidence_band(
                            delay_pred.predicted_delay_minutes, delay_pred.confidence
                        )

                timeline_json = gps_tracking.timeline_to_json(timeline_stops)

                # FEATURE: instant speed per GPS ping. TWO real sources,
                # preferred in this order:
                #   1. RailRadar's own live GPS speed reading
                #      (currentLocation.speedKmh) - a genuine instantaneous
                #      measurement that updates independently of which
                #      station is "current", so it moves every poll even
                #      between two halts.
                #   2. Distance-delta / time-delta between this poll and
                #      the last one, using RailKit's own distance_km. NOTE:
                #      RailKit's distance_km is a per-STATION figure from
                #      the route/schedule - it only changes when RailKit's
                #      own "current station" pointer advances to a new
                #      stop, so between two halts (or between two
                #      intermediate points RailKit doesn't report crossing
                #      in real time) this stays flat and (2) alone produces
                #      no new reading — hence source (1) being tried first.
                # Fed through a recency-weighted smoother either way, so a
                # single noisy ping doesn't spike the displayed figure.
                now_ts = datetime.now()
                try:
                    live_gps_speed, live_gps_speed_note = await asyncio.to_thread(
                        railradar_fallback.get_live_speed_kmph, train_number,
                    )
                except Exception:
                    live_gps_speed, live_gps_speed_note = None, None

                # FEATURE: smooth position/ETA between real station-crossing
                # updates, using RailRadar's real segmentProgress (see
                # railradar_fallback.get_segment_progress + gps_tracking.
                # interpolate_live_position) — shares the same underlying
                # RailRadar response as live_gps_speed above (cached), so
                # this costs no extra RailRadar call.
                try:
                    segment_info = await asyncio.to_thread(railradar_fallback.get_segment_progress, train_number)
                except Exception:
                    segment_info = {"segment_progress": None}

                # FEATURE: near-instant "current station" update on a real
                # arrival - see force_refresh_next_poll declared above. If
                # RailRadar's real segment progress shows the train is
                # essentially AT the next station (>=97% of the way there),
                # RailKit's own "current station" pointer is likely about to
                # flip on its next real update - so force the NEXT poll's
                # get_live_train_status call to skip its cache and fetch a
                # genuinely fresh read, instead of waiting out the rest of
                # a 45s TTL for an arrival that's basically already happened.
                _sp = segment_info.get("segment_progress")
                if _sp is not None and _sp >= 0.97:
                    force_refresh_next_poll = True

                # FEATURE: "RailRadar wins wherever it has live data" -
                # applied here to the displayed current/next station text,
                # not just position/speed (which already preferred RailRadar).
                # RailKit's own current-station pointer only advances when
                # ITS cached/polled schedule data says so; RailRadar's
                # currentLocation.stationCode is a real, independent GPS-
                # sourced read of where the train actually is right now.
                # When RailRadar has a REAL fix (is_actual_position=True,
                # not a schedule-based placeholder) for a DIFFERENT station
                # than RailKit currently reports, RailRadar's version is
                # shown instead - RailKit's timeline/schedule data (station
                # list, names, order) is still what's used to resolve the
                # actual station NAME and to find the correct next station,
                # since RailRadar only gives a bare code, not a full route -
                # this is "RailRadar wins the READING, RailKit still supplies
                # the STRUCTURE it's read against," matching the earlier
                # explanation of why RailKit can't be dropped entirely.
                current_station_display = position.current_station_name or position.current_station_code
                next_station_display = position.next_station_name or position.next_station_code
                # FEATURE: Station Navigator / Catering deep-link need a real
                # station CODE (not just a display name) for the current and
                # next station — tracked alongside the display names above,
                # defaulting to RailKit's own position codes and overridden
                # the same way current_station_display is when RailRadar's
                # real GPS fix wins below.
                current_station_code_display = position.current_station_code
                next_station_code_display = position.next_station_code
                current_station_source = "railkit"
                rr_code = segment_info.get("station_code")
                if rr_code and segment_info.get("is_actual_position") and rr_code != position.current_station_code:
                    rr_entry = next((s for s in timeline_json if s["code"] == rr_code), None)
                    rr_name = rr_entry["name"] if rr_entry else (gps_tracking._lookup_station(rr_code) or {}).get("name")
                    if rr_name:
                        current_station_display = rr_name
                        current_station_code_display = rr_code
                        current_station_source = "railradar_live_gps"
                        if rr_entry is not None:
                            rr_idx = timeline_json.index(rr_entry)
                            rr_next = next((s for s in timeline_json[rr_idx + 1:]), None)
                            if rr_next:
                                next_station_display = rr_next["name"] or rr_next["code"]
                                next_station_code_display = rr_next["code"]
                            # BUGFIX: the override above only patched the
                            # HEADLINE current_station_display text - it
                            # never touched each station's own `status`
                            # field in timeline_json, which is what the
                            # stop-by-stop list actually renders the train
                            # icon and passed/upcoming split from. So the
                            # headline field would jump to the real RailRadar
                            # position instantly, while the stop-by-stop
                            # list kept showing the OLD RailKit-reported
                            # station until RailKit's own slower "current
                            # station" pointer eventually caught up - the
                            # exact lag reported (instant at the top,
                            # "takes a long time" further down). Now that
                            # RailRadar has confirmed a REAL fix at a
                            # different station, every station's status is
                            # re-derived from that same real position in one
                            # pass, so the stop-by-stop list updates in the
                            # SAME poll as the headline field, not several
                            # polls later.
                            for i, s in enumerate(timeline_json):
                                s["status"] = "passed" if i < rr_idx else ("current" if i == rr_idx else "upcoming")

                current_position_distance_km = gps_tracking.current_position_distance_km(timeline_json)
                # FALLBACK: the live timeline entry for the current station
                # sometimes has no distance_km of its own (common for small
                # intermediate points RailKit's live feed reports sparsely,
                # even though the STATIC route does have it — that's exactly
                # what route_progress_ratio above is already built from).
                # Without this, both distance_delta_speed just below and the
                # next-station ETA further down go permanently None for the
                # entire stretch between two halts whenever this happens,
                # which is the "waiting for next ping" / blank-ETA bug.
                current_position_distance_source = "live_timeline"
                if current_position_distance_km is None:
                    current_position_distance_km = _route_distance_for_station(
                        train_info_data, position.current_station_code
                    )
                    current_position_distance_source = "static_route_fallback" if current_position_distance_km is not None else "unavailable"

                # Anchor for "distance covered since the last stop" below -
                # captured BEFORE the segment-progress interpolation
                # overrides current_position_distance_km, since this is
                # specifically the last real reporting station's own
                # distance figure (live or static-route fallback), not the
                # smoothly-moving live position itself.
                last_stop_distance_km = current_position_distance_km

                # Prefer the RailRadar segment-progress interpolation over
                # either of the above when it's available — it's the ONLY
                # one of the three that genuinely moves every single poll
                # (real crowdsourced GPS progress, not RailKit's coarse
                # "current station" pointer), so it also directly feeds a
                # fresh distance_delta_speed reading below on every poll
                # instead of only when RailKit itself advances stations.
                interp_distance_km, interp_lat, interp_lng = gps_tracking.interpolate_live_position(
                    timeline_json, segment_info.get("segment_progress")
                )
                if interp_distance_km is not None:
                    current_position_distance_km = interp_distance_km
                    current_position_distance_source = "railradar_segment_progress"

                # FEATURE: Route-Deviation/Diversion Detection — evaluated
                # every poll against the same live timeline_json already
                # built above (real per-station lat/lng), using whichever
                # position (interpolated or station-anchored) the map
                # marker itself will use below, so the flag always lines up
                # with what the passenger actually sees on the map. See
                # route_deviation.py for why this is a generous, sustained-
                # only flag rather than a single-ping trigger.
                _dev_lat = interp_lat if interp_lat is not None else position.lat
                _dev_lng = interp_lng if interp_lng is not None else position.lng
                _dev_reading = route_deviation.evaluate_point(_dev_lat, _dev_lng, timeline_json)
                _dev_sustained, _dev_seconds = deviation_tracker.update(_dev_reading.off_route, datetime.now())
                route_deviation_status = route_deviation.build_status(_dev_reading, _dev_sustained, _dev_seconds)

                # FEATURE: distance covered since the last stop, updated
                # every poll (not just on halt-crossing) since it's built
                # directly off current_position_distance_km, which already
                # moves every poll via the segment-progress interpolation
                # above when available, or the ping-to-ping distance-delta
                # otherwise. Floored at 0 - a poll landing marginally BEFORE
                # the anchor stop (e.g. a stale/slightly-early reading right
                # at departure) shouldn't show a negative distance.
                distance_covered_since_last_stop_km = None
                if current_position_distance_km is not None and last_stop_distance_km is not None:
                    distance_covered_since_last_stop_km = round(max(0.0, current_position_distance_km - last_stop_distance_km), 1)

                distance_delta_speed = gps_tracking.compute_instant_speed_kmph(
                    prev_position_distance_km, prev_position_timestamp,
                    current_position_distance_km, now_ts,
                )
                if live_gps_speed is not None:
                    instant_speed_kmph = live_gps_speed
                    instant_speed_source = "railradar_live_gps"
                elif distance_delta_speed is not None:
                    instant_speed_kmph = distance_delta_speed
                    instant_speed_source = "distance_delta_per_ping"
                else:
                    instant_speed_kmph = None
                    instant_speed_source = "none"
                speed_tracker.add(instant_speed_kmph, now_ts)
                recency_weighted_speed_kmph = speed_tracker.value()
                prev_position_distance_km = current_position_distance_km
                prev_position_timestamp = now_ts

                # FALLBACK (tier 3): neither RailRadar's live GPS speed nor a
                # ping-to-ping distance delta has come through yet this
                # session (e.g. RailRadar doesn't carry this train's GPS
                # feed at all, or the train hasn't crossed a halt since the
                # connection opened). Rather than leaving the UI on
                # "waiting for next ping" indefinitely, fall back to the
                # real recency-weighted delay-trend-informed avg_speed_kmph
                # already computed above — clearly a coarser, non-per-ping
                # figure, so it's labelled "avg_speed_estimate" and the
                # frontend shows it as an estimate rather than a live ping.
                display_speed_kmph = recency_weighted_speed_kmph
                display_speed_source = instant_speed_source if recency_weighted_speed_kmph is not None else "none"
                if display_speed_kmph is None and avg_speed_kmph is not None:
                    display_speed_kmph = avg_speed_kmph
                    display_speed_source = "avg_speed_estimate"

                # ETA recalculation uses the freshest real speed reading
                # available: recency-weighted instant speed (which is
                # already a real single-ping reading even with just one
                # sample so far — no need to wait for two), real
                # avg_speed_kmph otherwise (e.g. neither RailRadar's live
                # GPS speed nor a distance-delta reading has come through
                # yet this session).
                eta_speed_kmph = recency_weighted_speed_kmph if recency_weighted_speed_kmph is not None else avg_speed_kmph

                # FEATURE: per-station predicted delay for every upcoming
                # reporting halt (RailYatri-style), computed from the SAME
                # real trend + avg-speed signals as the single-figure
                # prediction below, just varied by each station's own real
                # route-progress. Also recomputes each station's live ETA
                # every ping. Mutates timeline_json in place.
                _predict_delay_per_reporting_station(
                    timeline_json, distance_km, position.delay_minutes,
                    delay_trend.get("trend_per_stop"), delay_trend.get("basis"),
                    avg_speed_kmph, avg_speed_basis, date_ddmmyyyy, travel_class,
                    eta_speed_kmph=eta_speed_kmph, train_info_data=train_info_data,
                    weather_component_minutes=weather_component_minutes, rr_stops=rr_stops,
                )
                # BUGFIX: reconcile the headline "ML-predicted delay" card
                # with the Live Tracking timeline's very next reporting
                # station whenever THAT station's figure is GROUNDED (real
                # expected-vs-predicted-ETA arithmetic, not a model guess -
                # see the "predicted_eta is the harder-to-fool number" note
                # inside _predict_delay_per_reporting_station). Before this,
                # the headline card used only the poll-smoothed ML ensemble
                # value (delay_tracker.value()), computed completely
                # independently of the per-station loop below it - so the
                # two could show very different "predicted delay" numbers
                # for the same train at the same moment (reported case: a
                # 55-min headline next to a real, schedule-grounded 22-min
                # figure for the very next halt a few km away). Grounded
                # evidence for the station the train is about to reach is
                # the more trustworthy number for "how late is this train
                # right now" than a multi-poll-smoothed model estimate, so
                # it now wins here too - same "real evidence beats a guess"
                # rule already applied station-to-station. Only the display
                # value is overridden; delay_tracker itself is left alone
                # so its own smoothed trend isn't skewed by re-adding this
                # value on top of the raw one already recorded above.
                next_reporting_upcoming = next(
                    (s for s in timeline_json
                     if s.get("status") == "upcoming" and s.get("kind") != "intermediate"),
                    None,
                )
                if (delay_pred is not None and next_reporting_upcoming is not None
                        and next_reporting_upcoming.get("predicted_delay_is_grounded")
                        and next_reporting_upcoming.get("predicted_delay_minutes") is not None):
                    grounded_value = next_reporting_upcoming["predicted_delay_minutes"]
                    if grounded_value != delay_pred.predicted_delay_minutes:
                        delay_pred.predicted_delay_minutes = grounded_value
                        delay_pred.low_minutes = next_reporting_upcoming.get(
                            "predicted_delay_low_minutes", delay_pred.low_minutes)
                        delay_pred.high_minutes = next_reporting_upcoming.get(
                            "predicted_delay_high_minutes", delay_pred.high_minutes)
                        delay_pred.basis = list(delay_pred.basis) + [
                            f"reconciled with {next_reporting_upcoming.get('name', 'the next station')}'s "
                            "real schedule-grounded delay (expected vs. predicted arrival)"
                        ]
                # FEATURE: RailYatri-style grouped display — consecutive
                # no-halt small stations collapsed into a single
                # "+N No-Halt stations" entry with the real distance span.
                timeline_grouped = gps_tracking.group_timeline_for_display(timeline_json)

                # FEATURE: auto-detected UP/DOWN running direction, used by
                # the frontend to rotate/flip the train marker icon to face
                # the actual direction of travel instead of a fixed image.
                direction_info = gps_tracking.determine_train_direction(train_number)

                # FEATURE: Expected vs Actual arrival, for the passenger's
                # own upcoming stop AND the train's final destination — the
                # per-stop expected/actual was already being computed in
                # timeline_stops (gps_tracking._parse_timing), just never
                # pulled up to top-level fields the Live Tracking tab could
                # show directly without walking the whole timeline itself.
                next_stop_json = next(
                    (s for s in timeline_json
                     if s["code"] == position.next_station_code
                     or s["name"] == position.next_station_name),
                    None,
                )
                # FEATURE: live weather at the NEXT station too (not just
                # current position) — real WeatherAPI.com reading at that
                # station's own lat/lng when available, None otherwise.
                next_station_weather = None
                if next_stop_json is not None:
                    next_station_weather = await asyncio.to_thread(
                        weather.get_current_weather, next_stop_json.get("lat"), next_stop_json.get("lng")
                    )
                # FEATURE: ETA to the very next stop, recalculated every
                # ping the same way as the per-station predictor above
                # (real remaining distance / freshest real speed reading) -
                # covers the next_stop_json case where that stop is a small
                # intermediate point rather than a reporting halt, which
                # _predict_delay_per_reporting_station doesn't annotate.
                next_station_live_eta = None
                distance_to_next_km = None
                if next_stop_json is not None:
                    next_stop_distance_km = gps_tracking._distance_km_value(next_stop_json.get("distance_km"))
                    if next_stop_distance_km is None:
                        # Same static-route fallback as current_position_distance_km
                        # above — the live timeline entry for a small
                        # upcoming intermediate point often has no
                        # distance_km of its own.
                        next_stop_distance_km = _route_distance_for_station(
                            train_info_data, next_stop_json.get("code")
                        )
                    if next_stop_distance_km is not None and current_position_distance_km is not None:
                        distance_to_next_km = max(0.0, next_stop_distance_km - current_position_distance_km)
                        next_station_live_eta = gps_tracking.compute_live_eta(distance_to_next_km, eta_speed_kmph)
                        # SECOND, complementary arrival signal (see the
                        # RailRadar segment_progress one above) for when
                        # RailRadar has no live GPS for this train at all -
                        # our own real remaining-distance figure showing the
                        # train is essentially at the next station is still
                        # a genuine signal worth forcing a fresh RailKit
                        # read on, even without RailRadar's confirmation.
                        if distance_to_next_km <= 1.5:
                            force_refresh_next_poll = True
                # Destination = the last *scheduled halt* in the timeline
                # (kind == "stoppage") when we can tell, else just the last
                # entry — RailKit's timeline is already ordered start to end.
                stoppages = [s for s in timeline_json if s.get("kind") != "intermediate"]
                destination_json = (stoppages or timeline_json or [None])[-1]

                # FEATURE: Dynamic Re-route Suggestions During Live Tracking.
                # See reroute_suggestions.py. Uses the SAME live timeline
                # already fetched this poll (next real scheduled halt +
                # final destination, both read off the train's own route -
                # never guessed) so triggering this costs no extra RailKit
                # call; the one real network call it can make
                # (search_trains_between_stations) is itself cached 6h, so
                # a delay that stays severe across many 5s polls doesn't
                # repeatedly hit the provider. Prefers the ML-predicted
                # delay (smoothed, reconciled with the next station above)
                # over the raw reported delay when both are available -
                # says plainly which one was used either way.
                if delay_pred is not None and delay_pred.predicted_delay_minutes is not None:
                    _reroute_delay_used, _reroute_delay_source = delay_pred.predicted_delay_minutes, "predicted"
                elif position.delay_minutes is not None:
                    _reroute_delay_used, _reroute_delay_source = position.delay_minutes, "reported"
                else:
                    _reroute_delay_used, _reroute_delay_source = None, None
                reroute = reroute_suggestions.compute_reroute_suggestions(
                    next_junction_code=(next_reporting_upcoming or {}).get("code"),
                    next_junction_name=(next_reporting_upcoming or {}).get("name"),
                    destination_code=(destination_json or {}).get("code"),
                    destination_name=(destination_json or {}).get("name"),
                    delay_minutes_used=_reroute_delay_used, delay_source=_reroute_delay_source,
                    date_ddmmyyyy=date_ddmmyyyy, threshold_minutes=reroute_threshold_minutes,
                )
                if reroute.triggered:
                    try:
                        analytics.record_event(intent="reroute_suggestion", train_number=train_number)
                    except Exception:
                        pass

                # FEATURE: tap-the-train-icon status popup ("Reached X~ /
                # Crossed X~ ... Report Inaccuracy", RailYatri-style).
                # `current_timeline_entry` tells the frontend whether the
                # train is AT a real halt ("Reached") or passing a small
                # intermediate point ("Crossed"), plus that station's real
                # halt_minutes for the popup. `status_response_id` registers
                # this exact status snapshot with the SAME response-log
                # feedback_rlhf.py already uses for chat 👍/👎 — the
                # frontend's "Report Inaccuracy" button posts a 👎 against
                # this id via the existing POST /api/feedback, so a report
                # is real, traceable feedback data, not a no-op button.
                current_timeline_entry = next((s for s in timeline_json if s.get("status") == "current"), None)
                status_response_id = uuid.uuid4().hex
                status_updated_at = datetime.now().isoformat()
                try:
                    feedback_rlhf.record_response(
                        status_response_id,
                        question=f"Live status for train {train_number} at "
                                 f"{position.current_station_name or position.current_station_code}",
                        answer=(
                            f"current_station={position.current_station_name}; "
                            f"delay_minutes={position.delay_minutes}; "
                            f"predicted_delay_minutes={delay_pred.predicted_delay_minutes if delay_pred else None}"
                        ),
                        intent="live_tracking_status",
                    )
                except Exception:
                    pass

                payload.update({
                    # FEATURE: prefer the RailRadar segment-progress
                    # interpolated lat/lng for the map marker when
                    # available — moves smoothly along the real route line
                    # every poll instead of only jumping when RailKit's own
                    # "current station" changes. Falls back to RailKit's own
                    # station-anchored position otherwise, same as before.
                    "lat": interp_lat if interp_lat is not None else position.lat,
                    "lng": interp_lng if interp_lng is not None else position.lng,
                    "current_station": current_station_display,
                    "next_station": next_station_display,
                    # FEATURE: Station Navigator / Catering Pre-Order — real
                    # station codes to build deep links / POI lookups from,
                    # alongside the display names above.
                    "current_station_code": current_station_code_display,
                    "next_station_code": next_station_code_display,
                    "current_station_source": current_station_source,
                    "delay_minutes": position.delay_minutes,
                    "position_source": "railradar_segment_progress" if interp_lat is not None else position.position_source,
                    "segment_progress_pct": round(segment_info["segment_progress"] * 100, 1) if segment_info.get("segment_progress") is not None else None,
                    "predicted_delay_minutes": delay_pred.predicted_delay_minutes if delay_pred else None,
                    "predicted_delay_confidence": delay_pred.confidence if delay_pred else None,
                    "predicted_delay_basis": delay_pred.basis if delay_pred else None,
                    "predicted_delay_model": delay_pred.model_name if delay_pred else None,
                    # Confidence band around predicted_delay_minutes - see
                    # delay_prediction._confidence_band. Narrower for High
                    # confidence, wider for Low, instead of implying false
                    # precision with a single point figure.
                    "predicted_delay_low_minutes": delay_pred.low_minutes if delay_pred else None,
                    "predicted_delay_high_minutes": delay_pred.high_minutes if delay_pred else None,
                    # Real per-station delay trend + average running speed —
                    # shown alongside the prediction so the passenger can see
                    # exactly which crossed stations/speed it's based on.
                    "recent_delay_trend_per_stop": delay_trend.get("trend_per_stop"),
                    "recent_delay_trend_basis": delay_trend.get("basis"),
                    "avg_speed_kmph": avg_speed_kmph,
                    "avg_speed_basis": avg_speed_basis,
                    # FEATURE: instant speed per GPS ping - RailRadar's own
                    # live GPS speedKmh reading when available (updates
                    # every poll, independent of which station is
                    # "current"), else a distance-delta/time-delta reading
                    # off RailKit's per-station distance figures (only
                    # produces a new value once RailKit itself advances
                    # which station is "current" - see the comment above
                    # this block in the code). None on the very first ping
                    # of a session, or any ping where neither source had
                    # anything real. recency_weighted_speed_kmph is the
                    # smoothed "current pace" reading (see
                    # gps_tracking.RecencyWeightedSpeed) - prefer this one
                    # for display, it's what stays reactive without
                    # jittering on a single noisy ping. avg_speed_kmph
                    # above remains the whole-trip/whole-window average -
                    # show both so the difference between "pace right now"
                    # and "average since departure" is visible.
                    "instant_speed_kmph": instant_speed_kmph,
                    "instant_speed_source": instant_speed_source,
                    "recency_weighted_speed_kmph": recency_weighted_speed_kmph,
                    # FALLBACK (tier 3) display figure: when NEITHER a real
                    # per-ping reading (live GPS or distance-delta) nor a
                    # smoothed value has come through yet this session
                    # (e.g. RailRadar has no GPS feed at all for this train,
                    # which is exactly the "position interpolated" case),
                    # this is avg_speed_kmph instead of a blank "waiting for
                    # next ping". display_speed_source == "avg_speed_estimate"
                    # tells the frontend to label it as an estimate rather
                    # than a live reading. Prefer this field for the
                    # "Current speed" UI element over instant/recency-weighted
                    # directly, since it's the one that's never null once
                    # avg_speed_kmph itself is available.
                    "display_speed_kmph": display_speed_kmph,
                    "display_speed_source": display_speed_source,
                    # FEATURE: live weather at the train's current position
                    # (see weather.py) — real WeatherAPI.com reading, None if
                    # WEATHER_API_KEY isn't set or the call failed (never a
                    # guess). weather_delay_component_minutes is the same
                    # bounded fog/rain figure already folded into
                    # delay_pred / predicted_delay_minutes above — surfaced
                    # separately here so the UI can show its own "why" line.
                    "current_weather": current_weather,
                    "next_station_weather": next_station_weather,
                    "weather_delay_component_minutes": weather_component_minutes or None,
                    "weather_basis": weather_basis,
                    "weather_source_error": None if current_weather else weather.get_last_error(),
                    # "railkit"/"railradar"/"railkit+railradar_avg" = a real
                    # measurement from one or both providers; "railradar_live_gps"
                    # = RailRadar's own live GPS speed reading; "ml_estimate" =
                    # no real reading was available yet, so this is the ML
                    # instant estimate — the frontend/mobile app should label
                    # it as an estimate, not a measurement, when this is "ml_estimate".
                    "avg_speed_source": avg_speed_source_ws,
                    # Auto-detected UP/DOWN direction, for rotating the map marker.
                    "direction": direction_info.get("direction"),
                    "direction_basis": direction_info.get("basis"),
                    "timeline": timeline_json,
                    # Grouped, RailYatri-style version of the same timeline —
                    # no-halt runs collapsed, each upcoming halt carrying its
                    # own predicted_delay_minutes. Prefer this in new UI;
                    # "timeline" above is kept for backward compatibility.
                    "timeline_grouped": timeline_grouped,
                    # Tap-the-train-icon status popup fields.
                    "current_station_kind": (current_timeline_entry or {}).get("kind"),
                    "current_station_halt_minutes": (current_timeline_entry or {}).get("halt_minutes"),
                    # Real clock time the train reached/crossed this station
                    # (RailYatri-style "Crossed X~ at HH:MM") — whichever
                    # REAL actual timestamp the current station has, arrival
                    # preferred (it's usually set first); never invented,
                    # left out entirely if RailKit hasn't reported one yet.
                    "current_station_actual_time": (
                        ((current_timeline_entry or {}).get("arrival") or {}).get("actual")
                        or ((current_timeline_entry or {}).get("departure") or {}).get("actual")
                    ),
                    "status_response_id": status_response_id,
                    "status_updated_at": status_updated_at,
                    # Expected/actual arrival at the NEXT stop the train is
                    # headed to (what a passenger waiting there cares about).
                    # Locally recomputed every ping (see above) - distinct
                    # from next_station_expected_arrival below, which is
                    # RailKit's own `expected` field and only refreshes
                    # when the provider itself updates it (typically at
                    # halt-crossing time).
                    "next_station_live_eta": next_station_live_eta,
                    # FEATURE: real-time distance progress toward the next
                    # station, updated every poll - "covered" moves via the
                    # RailRadar segment-progress interpolation (or the
                    # ping-to-ping delta as fallback) the same way current
                    # speed already does; "remaining" is just the
                    # complementary real subtraction against that same
                    # station's own real distance figure. Both None
                    # together only when neither the current position nor
                    # the next station's distance could be resolved at all.
                    "distance_covered_since_last_stop_km": distance_covered_since_last_stop_km,
                    "distance_remaining_to_next_km": round(distance_to_next_km, 1) if distance_to_next_km is not None else None,
                    "next_station_expected_arrival": (next_stop_json or {}).get("arrival", {}).get("expected"),
                    "next_station_actual_arrival": (next_stop_json or {}).get("arrival", {}).get("actual"),
                    "next_station_scheduled_arrival": (next_stop_json or {}).get("arrival", {}).get("scheduled"),
                    # Expected/actual arrival at the train's FINAL destination.
                    "destination_station": (destination_json or {}).get("name"),
                    "destination_code": (destination_json or {}).get("code"),
                    "destination_scheduled_arrival": (destination_json or {}).get("arrival", {}).get("scheduled"),
                    "destination_expected_arrival": (destination_json or {}).get("arrival", {}).get("expected"),
                    "destination_actual_arrival": (destination_json or {}).get("arrival", {}).get("actual"),
                    # FEATURE: Dynamic Re-route Suggestions During Live
                    # Tracking — see reroute_suggestions.py. `triggered`
                    # tells the frontend/mobile whether to surface the
                    # alert at all; `note`/`disclaimer` are always safe to
                    # show verbatim, and direct_alternatives/
                    # alternative_routes are only ever real, never invented.
                    "reroute_suggestion": reroute_suggestions.to_dict(reroute),
                    "route_deviation": route_deviation.to_dict(route_deviation_status),
                    "error": None,
                })
                try:
                    analytics.record_event(
                        intent="live_tracking", train_number=train_number,
                        delay_minutes=position.delay_minutes,
                        predicted_delay_minutes=delay_pred.predicted_delay_minutes if delay_pred else None,
                    )
                except Exception:
                    pass

                # FEATURE: Background-surviving Smart Alarm — live-tracking
                # trigger. Cheap no-op when nobody has armed a background
                # alarm for THIS train (list_alarm_watches_for_train is an
                # indexed lookup that returns empty instantly) — only runs
                # the real smart-alarm check when a matching watch exists.
                try:
                    alert_scheduler.check_and_push_alarm_for_train(train_number, date_ddmmyyyy, _alarm_check_for_watch)
                except Exception:
                    pass
            except railway_api.RailwayAPIError as e:
                payload["error"] = str(e)
                try:
                    analytics.record_event(intent="live_tracking", train_number=train_number, live_error=True)
                except Exception:
                    pass
            await websocket.send_json(payload)

            # Auto-refresh every _TRACK_POLL_INTERVAL_SECONDS (5s) — but if the
            # client sends ANY message before that (the "Refresh now" button
            # just pings `{"type":"refresh"}`), wake up immediately instead of
            # waiting out the rest of the interval. A real client disconnect
            # surfaces here too (receive_text raises WebSocketDisconnect),
            # so this replaces the old bare sleep() without losing that path.
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=_TRACK_POLL_INTERVAL_SECONDS)
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        pass


# =============================================================================
# FEATURE: Advanced Charting & Analytics Dashboard
# =============================================================================
@app.get("/api/analytics/summary")
def api_analytics_summary():
    return analytics.summary()


@app.get("/api/analytics/train/{train_number}")
def api_analytics_train(train_number: str, limit: int = 100):
    """Delay history (actual vs ML-predicted) logged so far this session for
    ONE specific train — powers the chart in the Live Tracking panel. Pulls
    from the same real-events log as the general dashboard, just filtered."""
    return analytics.train_delay_history(train_number, limit=limit)


# =============================================================================
# FEATURE: User Feedback Loop with Reinforcement Learning (RLHF) Data Collection
# =============================================================================
class FeedbackRequest(BaseModel):
    response_id: str
    rating: str                      # "up" | "down"
    correction: Optional[str] = None  # what the answer SHOULD have said (down only)
    reason: Optional[str] = None      # short free-text reason (either rating)


@app.post("/api/feedback")
def api_feedback(req: FeedbackRequest):
    try:
        event = feedback_rlhf.record_feedback(
            req.response_id, req.rating, correction=req.correction, reason=req.reason,
        )
        return {"ok": True, "response_id": event.response_id, "rating": event.rating}
    except feedback_rlhf.UnknownResponseError as e:
        return {"ok": True, "warning": str(e)}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/feedback/stats")
def api_feedback_stats():
    return feedback_rlhf.stats()


@app.get("/api/feedback/export")
def api_feedback_export(limit: int = 500):
    """RLHF-ready (prompt, chosen, rejected) preference pairs shaped from
    the collected feedback log — see feedback_rlhf.py for the shaping rules."""
    return feedback_rlhf.export_preference_pairs(limit=limit)


# =============================================================================
# FEATURE: Few-Shot Learning for New Intents
# =============================================================================
class TeachIntentRequest(BaseModel):
    name: str
    examples: List[str]
    response_hint: Optional[str] = None


@app.post("/api/intents/teach")
def api_teach_intent(req: TeachIntentRequest):
    try:
        taught = few_shot_intents.teach_intent(req.name, req.examples, req.response_hint)
        return {"ok": True, "name": taught.name, "example_count": len(taught.examples)}
    except ValueError as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/intents/list")
def api_list_intents():
    return {
        "intents": [
            {"name": i.name, "examples": i.examples, "response_hint": i.response_hint}
            for i in few_shot_intents.list_intents()
        ]
    }


class DeleteIntentRequest(BaseModel):
    name: str


@app.post("/api/intents/delete")
def api_delete_intent(req: DeleteIntentRequest):
    deleted = few_shot_intents.delete_intent(req.name)
    return {"ok": deleted}


# =============================================================================
# FEATURE: Automatic keyword/intent discovery (auto_keyword_discovery.py)
# Replaces the manual "someone notices a gap, writes a keyword or calls
# /api/intents/teach" loop above. Call this periodically (a cron job or an
# ops person clicking one button) and it clusters recent GENERAL_FAQ misses
# (logged in analytics.py) and auto-teaches new few-shot intents on its own
# - no keywords typed, no code change, no /api/intents/teach call needed.
# =============================================================================
@app.post("/api/intents/auto-discover")
def api_auto_discover_intents(min_cluster_size: int = 3, max_new_intents: int = 5):
    try:
        result = auto_keyword_discovery.run_auto_discovery(
            get_engine().hybrid._semantic_engine,
            min_cluster_size=min_cluster_size,
            max_new_intents=max_new_intents,
        )
        return {"ok": True, **result}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/api/intents/misses")
def api_recent_misses(limit: int = 200):
    """Raw log of unrecognized questions auto-discovery draws from -
    useful to eyeball before/after triggering a discovery run."""
    return {"misses": analytics.get_recent_misses(limit=limit)}


# =============================================================================
# FEATURE: Real-Time Sentiment and Emotion Analysis
# =============================================================================
class SentimentRequest(BaseModel):
    text: str


@app.post("/api/sentiment/analyze")
def api_sentiment_analyze(req: SentimentRequest):
    """Standalone probe for the same analyzer /api/chat runs inline on every
    message — useful for testing/tuning the lexicon without a full chat turn."""
    result = sentiment_analysis.analyze(req.text)
    return {
        "sentiment": result.sentiment,
        "score": result.sentiment_score,
        "emotion": result.emotion,
        "is_urgent": result.is_urgent,
        "is_frustrated": result.is_frustrated,
        "matched_signals": result.matched_signals,
    }


# Serve the frontend as a static site at the root path.
# =============================================================================
# FEATURE: Shareable Read-Only Tracking Link. A plain URL
# (PUBLIC_APP_URL + "/track/12951") that opens directly to a live-tracking
# view — no login (there isn't one anywhere in this app), no app install,
# no need to re-type the train number. It talks to the SAME public
# /ws/track/{train_number} websocket the main app itself uses — that socket
# already has no auth of its own, so this page needs none either.
# Registered explicitly (matched before the StaticFiles catch-all mount
# below) so "/track/12951" resolves here rather than a literal (nonexistent)
# static file.
#
# Which UI a visitor gets depends on the device they open the link on:
#   - Phone (User-Agent looks like a mobile browser): the small standalone
#     lite page (frontend/track.html + track.js) — genuinely lightweight,
#     matches the mobile app's own read-only tracking screen, and can't
#     regress if the main desktop app's tracking UI changes.
#   - Desktop/laptop browser: redirected into the full web app
#     (index.html/app.js) with the Live Tracking panel auto-opened and
#     already tracking this train, so desktop visitors get the richer full
#     app experience (bigger map, delay chart, coach crowding, etc.)
#     instead of the phone-sized lite view.
# =============================================================================
_MOBILE_UA_RE = re.compile(
    r"Mobi|Android|iPhone|iPod|IEMobile|BlackBerry|Opera Mini|Windows Phone",
    re.IGNORECASE,
)


def _looks_like_mobile(user_agent: str) -> bool:
    return bool(_MOBILE_UA_RE.search(user_agent or ""))


@app.get("/track/{train_number}")
def track_share_page(train_number: str, request: Request, date: Optional[str] = None):
    user_agent = request.headers.get("user-agent", "")
    if _looks_like_mobile(user_agent):
        return FileResponse(os.path.join(FRONTEND_DIR, "track.html"))

    # Desktop: hand off to the full app UI via a redirect (not a direct
    # FileResponse of index.html) so index.html's own relative asset paths
    # ("app.js", "style.css", ...) keep resolving correctly against "/"
    # instead of against "/track/<number>".
    query = f"openTrack={train_number}"
    if date:
        query += f"&openTrackDate={date}"
    return RedirectResponse(url=f"/?{query}")


# =============================================================================
# FEATURE: End-of-Trip Summary Card — the shareable recap page itself
# (frontend/trip.html + trip.js fetches /api/trip-summary/{share_id} and
# renders it). Same "own small standalone page" reasoning as /track above.
# =============================================================================
@app.get("/trip/{share_id}")
def trip_summary_page(share_id: str):
    return FileResponse(os.path.join(FRONTEND_DIR, "trip.html"))


# =============================================================================
# FEATURE: Device-based home page — same idea as /track above, but for the
# site's root URL itself.
#   - Phone/tablet browser: redirected into the exported mobile-app (Expo/
#     React Native web build, served as static files from MOBILE_WEB_DIR)
#     mounted at /mobile-app, so mobile visitors to the bare domain get the
#     actual mobile-app UI instead of the desktop-oriented web frontend.
#   - Desktop/laptop browser: unchanged — the existing full web app
#     (frontend/index.html).
# Registered before the catch-all StaticFiles mount below (and the
# /mobile-app mount is also registered before that same catch-all) so both
# take precedence over it, exactly like /track/{train_number} already does.
# =============================================================================
_MOBILE_WEB_INDEX = os.path.join(MOBILE_WEB_DIR, "index.html")


@app.get("/")
def home_page(request: Request):
    user_agent = request.headers.get("user-agent", "")
    if _looks_like_mobile(user_agent) and os.path.isfile(_MOBILE_WEB_INDEX):
        return RedirectResponse(url="/mobile-app/")
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


if os.path.isdir(MOBILE_WEB_DIR):
    app.mount("/mobile-app", StaticFiles(directory=MOBILE_WEB_DIR, html=True), name="mobile_web")

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
"""
railway_agent.py
-----------------
Agentic layer on top of the rule-based pipeline.

query_router.classify() maps a message to ONE fixed intent using regex and
keywords. That is fast and predictable, but it can't cope with questions that
need several lookups ("cheapest way from Vijayawada to Chennai tomorrow"), are
phrased unusually, or fall outside every keyword list. Those used to end in
"I couldn't find anything relevant" or a raw provider error.

This module lets an LLM *plan* instead: it is given a set of tools (the same
railway data functions the fixed router already calls, plus the knowledge base
and web search), decides which to call and in what order, reads the results,
and keeps going until it can answer. If one tool fails or returns nothing it
tries another (e.g. the timetable fails -> knowledge base -> web search), so a
railway question ends in an answer rather than an error message.

Design notes
  * Tools never raise. Failures come back as {"error": ...} so the model can
    recover on its own.
  * Same provider order as the rest of the app: Gemini first, Claude second.
    With no key configured, run_agent() reports that so the caller can fall
    back to the existing deterministic path.
  * Tools are declared once (TOOLS) and converted to each provider's format.
"""

import json
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import railway_api
import gps_tracking
import trains_between
import nearby_stations
import route_planner
import crowd_prediction
import station_search
import web_search

MAX_STEPS = int(os.environ.get("AGENT_MAX_STEPS", "6"))
MAX_TOOL_RESULT_CHARS = 6000  # keeps a 40-stop timetable from flooding the context window


# --------------------------------------------------------------------------
# Result type
# --------------------------------------------------------------------------
@dataclass
class AgentStep:
    tool: str
    args: dict
    ok: bool
    summary: str


@dataclass
class AgentResult:
    answer: Optional[str] = None
    steps: List[AgentStep] = field(default_factory=list)
    provider: Optional[str] = None
    error: Optional[str] = None
    map_payload: Optional[dict] = None
    web_sources: List[dict] = field(default_factory=list)


# --------------------------------------------------------------------------
# Tool implementations. Each returns a JSON-serialisable dict, never raises.
# --------------------------------------------------------------------------
def _clip(obj: Any) -> Any:
    text = json.dumps(obj, default=str, ensure_ascii=False)
    if len(text) <= MAX_TOOL_RESULT_CHARS:
        return obj
    return {"truncated": True, "content": text[:MAX_TOOL_RESULT_CHARS] + " ...[truncated]"}


def _err(exc: Exception) -> dict:
    return {"error": str(exc) or type(exc).__name__}


def _code(value: str) -> Optional[str]:
    """Station name / city / code -> station code, using the same resolver as
    the Search Trains form, so the model may pass 'Vijayawada' or 'BZA'."""
    import entity_gazetteer  # local import: heavy module, only needed here
    text = (value or "").strip()
    if not text:
        return None
    exact = entity_gazetteer._GAZETTEER.get(text.lower())
    if exact:
        return exact
    if re.fullmatch(r"[A-Za-z]{2,5}", text):
        return text.upper()
    result = station_search.search_stations(text, top_k=1)
    return result.matches[0].code if result.matches else None


def tool_find_station(query: str) -> dict:
    try:
        res = station_search.search_stations(query, top_k=5)
        return {"matches": [{"code": m.code, "name": m.name} for m in res.matches]}
    except Exception as exc:
        return _err(exc)


def tool_train_schedule(train_number: str) -> dict:
    try:
        raw = railway_api.get_train_schedule(train_number)
        route = gps_tracking.parse_route(raw)
        return _clip({
            "train_number": train_number,
            "total_stops": len(route),
            "stops": [
                {"code": s.code, "name": s.name, "arrives": s.scheduled_arrival,
                 "departs": s.scheduled_departure, "distance_km": s.distance_km}
                for s in route
            ],
        })
    except Exception as exc:
        return _err(exc)


def tool_live_train_status(train_number: str, date: str = "") -> dict:
    try:
        raw = railway_api.get_live_train_status(train_number, date or None)
        pos = gps_tracking.parse_live_position(train_number, raw)
        return {
            "train_number": train_number, "train_name": pos.train_name, "status": pos.status_note,
            "current_station": pos.current_station_name or pos.current_station_code,
            "next_station": pos.next_station_name or pos.next_station_code,
            "delay_minutes": pos.delay_minutes,
        }
    except Exception as exc:
        primary_error = _err(exc)
    # RailKit failed: try RailRadar, the app's second live source.
    try:
        import railradar_fallback
        stops = railradar_fallback.fetch_railradar_timeline(train_number, date or None)
        current = next((st for st in stops if st.status == "current"), None)
        nxt = next((st for st in stops if st.status == "upcoming"), None)
        if current or nxt:
            return {
                "train_number": train_number, "source": "railradar",
                "current_station": (current.name or current.code) if current else None,
                "next_station": (nxt.name or nxt.code) if nxt else None,
            }
    except Exception:
        pass
    return primary_error


def tool_trains_between(source: str, destination: str, date: str = "") -> dict:
    src, dst = _code(source), _code(destination)
    if not src or not dst:
        return {"error": f"Could not resolve station '{source if not src else destination}'. Use find_station first."}
    try:
        raw = railway_api.search_trains_between_stations(src, dst, date or None)
        trains = trains_between.parse_trains_list(raw)
        return _clip({
            "source": src, "destination": dst, "count": len(trains),
            "trains": [
                {"train_number": t.train_number, "name": t.train_name,
                 "departs": t.source_departure, "arrives": t.dest_arrival}
                for t in trains[:15]
            ],
        })
    except Exception as exc:
        return _err(exc)


def tool_seat_availability(train_number: str, source: str, destination: str, date: str,
                           travel_class: str = "SL") -> dict:
    src, dst = _code(source), _code(destination)
    if not src or not dst:
        return {"error": "Could not resolve the source/destination station."}
    try:
        return _clip(railway_api.get_seat_availability(train_number, src, dst, date, travel_class.upper()))
    except Exception as exc:
        return _err(exc)


def tool_fare(train_number: str, source: str, destination: str, date: str, travel_class: str = "SL") -> dict:
    src, dst = _code(source), _code(destination)
    if not src or not dst:
        return {"error": "Could not resolve the source/destination station."}
    try:
        return _clip(railway_api.get_fare(train_number, src, dst, date, travel_class.upper()))
    except Exception as exc:
        return _err(exc)


def tool_pnr_status(pnr: str) -> dict:
    try:
        return _clip(railway_api.get_pnr_status(pnr))
    except Exception as exc:
        return _err(exc)


def tool_nearby_stations(station: str, radius_km: float = 150.0) -> dict:
    code = _code(station)
    if not code:
        return {"error": f"Could not resolve station '{station}'."}
    try:
        return {"summary": nearby_stations.format_nearby_stations(
            nearby_stations.find_nearby_stations(code, radius_km=radius_km, limit=5))}
    except Exception as exc:
        return _err(exc)


def tool_alternative_routes(source: str, destination: str) -> dict:
    src, dst = _code(source), _code(destination)
    if not src or not dst:
        return {"error": "Could not resolve the source/destination station."}
    try:
        return {"summary": route_planner.format_route_options(route_planner.find_alternative_routes(src, dst, k=3))}
    except Exception as exc:
        return _err(exc)


def tool_predict_crowd(travel_class: str = "SL", date: str = "") -> dict:
    try:
        pred = crowd_prediction.predict_crowd(travel_class=travel_class.upper(), date_ddmmyyyy=date or None)
        return {"summary": crowd_prediction.format_crowd_prediction(pred)}
    except Exception as exc:
        return _err(exc)


def tool_search_knowledge_base(query: str) -> dict:
    """Railway rules/policies: Tatkal, refunds, quotas, coach classes, luggage, RAC/waitlist..."""
    try:
        from rag_engine import get_engine
        res = get_engine().retrieve(query, top_k=4)
        return {"excerpts": [{"topic": c.category, "text": c.compressed_text} for c in res.chunks]}
    except Exception as exc:
        return _err(exc)


# Sources from web_search calls in the current run, so the API response can
# list them the way the fixed pipeline does. Reset per run_agent() call.
_web_sources_this_run: List[dict] = []


def tool_web_search(query: str) -> dict:
    try:
        results = web_search.search_web(query, max_results=5)
    except Exception as exc:
        return _err(exc)
    for r in results:
        _web_sources_this_run.append({"title": r.title, "url": r.url})
    return {"results": [{"title": r.title, "snippet": r.snippet, "url": r.url} for r in results]}


def _spec(name, fn, description, props, required):
    return {
        "name": name, "fn": fn, "description": description,
        "schema": {"type": "object", "properties": props, "required": required},
    }


_S = {"type": "string"}
TOOLS: List[dict] = [
    _spec("find_station", tool_find_station,
          "Look up station codes from a station or city name (e.g. 'Vijayawada' -> BZA).",
          {"query": _S}, ["query"]),
    _spec("train_schedule", tool_train_schedule,
          "Timetable of a train: every stop with arrival/departure times and distance.",
          {"train_number": {"type": "string", "description": "5-digit train number"}}, ["train_number"]),
    _spec("live_train_status", tool_live_train_status,
          "Live running status: where a train is now, next station, delay in minutes.",
          {"train_number": {"type": "string"}, "date": {"type": "string", "description": "DD-MM-YYYY, optional (default today)"}},
          ["train_number"]),
    _spec("trains_between_stations", tool_trains_between,
          "Trains running between two stations (names or codes accepted).",
          {"source": _S, "destination": _S, "date": {"type": "string", "description": "DD-MM-YYYY, optional"}},
          ["source", "destination"]),
    _spec("seat_availability", tool_seat_availability,
          "Seat/berth availability for one train, route, date and class (SL, 3A, 2A, 1A, CC, EC, 2S).",
          {"train_number": _S, "source": _S, "destination": _S, "date": {"type": "string", "description": "DD-MM-YYYY"},
           "travel_class": _S}, ["train_number", "source", "destination", "date"]),
    _spec("fare", tool_fare, "Fare for one train, route, date and class.",
          {"train_number": _S, "source": _S, "destination": _S, "date": {"type": "string", "description": "DD-MM-YYYY"},
           "travel_class": _S}, ["train_number", "source", "destination", "date"]),
    _spec("pnr_status", tool_pnr_status, "Booking/PNR status for a 10-digit PNR.",
          {"pnr": {"type": "string"}}, ["pnr"]),
    _spec("nearby_stations", tool_nearby_stations, "Railway stations near a given station.",
          {"station": _S, "radius_km": {"type": "number"}}, ["station"]),
    _spec("alternative_routes", tool_alternative_routes,
          "Alternative rail corridors between two stations (useful when the direct route is disrupted or full).",
          {"source": _S, "destination": _S}, ["source", "destination"]),
    _spec("predict_crowd", tool_predict_crowd, "Estimated crowding level for a travel class and date.",
          {"travel_class": _S, "date": {"type": "string", "description": "DD-MM-YYYY"}}, []),
    _spec("search_knowledge_base", tool_search_knowledge_base,
          "Railway rules and policies: Tatkal, refunds/cancellation, quotas, coach classes, luggage, "
          "RAC/waitlist, concessions, chart preparation, etc. Try this before web_search for rule questions.",
          {"query": _S}, ["query"]),
    _spec("web_search", tool_web_search,
          "Search the web for current information the other tools lack (disruptions, news, unusual questions).",
          {"query": _S}, ["query"]),
]
_TOOL_FNS: Dict[str, Callable] = {t["name"]: t["fn"] for t in TOOLS}


def execute_tool(name: str, args: Optional[dict]) -> dict:
    fn = _TOOL_FNS.get(name)
    if fn is None:
        return {"error": f"Unknown tool '{name}'. Available: {', '.join(_TOOL_FNS)}"}
    try:
        return fn(**(args or {}))
    except TypeError as exc:  # model passed wrong/missing arguments
        return {"error": f"Bad arguments for {name}: {exc}"}
    except Exception as exc:
        return _err(exc)


def _step_summary(result: dict) -> str:
    text = json.dumps(result, default=str, ensure_ascii=False)
    return text[:160] + ("…" if len(text) > 160 else "")


# --------------------------------------------------------------------------
# Prompting
# --------------------------------------------------------------------------
def build_system_prompt(extra: str = "") -> str:
    today = datetime.now().strftime("%A, %d-%m-%Y")
    return (
        "You are an Indian Railways assistant that can call tools to answer passenger questions. "
        f"Today is {today}; resolve 'today', 'tomorrow', weekdays etc. to DD-MM-YYYY yourself.\n\n"
        "How to work:\n"
        "- Decide which tools you need, call them, read the results, and call more if needed. "
        "You may combine several (e.g. find trains between stations, then check seats on the best one).\n"
        "- If a tool returns an error or nothing useful, do NOT give up: try a different tool or different "
        "arguments (e.g. live status fails -> timetable -> web_search; unknown rule -> search_knowledge_base "
        "then web_search). Only after reasonable attempts, say what you could and couldn't find.\n"
        "- Ground every train number, time, fare and status in tool results. Never invent them. If the "
        "answer came from a web search, say so briefly.\n"
        "- Never answer with just 'not available' or a raw error message. Give the best useful answer you can "
        "(partial data, the timetable instead of live status, general guidance, or a clear question asking for "
        "the one detail you truly need, such as the train number).\n"
        "- Do not mention tools, APIs or internal errors to the user. Keep it concise: plain sentences or simple "
        "'-' bullets, no markdown headers.\n"
        "- If the question is not about railways/travel, politely say you help with railway questions."
        + (("\n\n" + extra) if extra else "")
    )


# --------------------------------------------------------------------------
# Provider loops
# --------------------------------------------------------------------------
def _record(result: AgentResult, name: str, args: dict, output: dict) -> None:
    result.steps.append(AgentStep(name, dict(args or {}), "error" not in output, _step_summary(output)))


def _run_claude(question: str, system: str, result: AgentResult) -> Optional[str]:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return None
    import anthropic
    client = anthropic.Anthropic(api_key=api_key)
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5")
    tools = [{"name": t["name"], "description": t["description"], "input_schema": t["schema"]} for t in TOOLS]
    messages = [{"role": "user", "content": question}]

    for step in range(MAX_STEPS + 1):
        last = step == MAX_STEPS
        # Final turn: step budget spent, so tell the model to answer from what it has.
        sys_prompt = system + ("\n\nYou have used all tool calls. Answer now from what you gathered; "
                               "do not call any more tools." if last else "")
        resp = client.messages.create(model=model, max_tokens=2048, system=sys_prompt, tools=tools, messages=messages)
        if resp.stop_reason != "tool_use" or last:
            return "".join(b.text for b in resp.content if b.type == "text").strip() or None
        messages.append({"role": "assistant", "content": resp.content})
        outputs = []
        for block in resp.content:
            if block.type != "tool_use":
                continue
            out = execute_tool(block.name, block.input)
            _record(result, block.name, block.input, out)
            outputs.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": json.dumps(out, default=str, ensure_ascii=False),
                            "is_error": "error" in out})
        messages.append({"role": "user", "content": outputs})
    return None


def _gemini_schema(node: dict) -> dict:
    out = {k: v for k, v in node.items() if k != "type"}
    out["type"] = str(node.get("type", "string")).upper()
    if "properties" in node:
        out["properties"] = {k: _gemini_schema(v) for k, v in node["properties"].items()}
    return out


def _run_gemini(question: str, system: str, result: AgentResult) -> Optional[str]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    from google import genai
    from google.genai import types
    client = genai.Client(api_key=api_key)
    model = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
    decls = [types.FunctionDeclaration(name=t["name"], description=t["description"],
                                       parameters=_gemini_schema(t["schema"])) for t in TOOLS]
    config = types.GenerateContentConfig(
        system_instruction=system, max_output_tokens=2048,
        tools=[types.Tool(function_declarations=decls)],
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )
    contents = [types.Content(role="user", parts=[types.Part(text=question)])]

    for step in range(MAX_STEPS + 1):
        last = step == MAX_STEPS
        cfg = config if not last else types.GenerateContentConfig(system_instruction=system, max_output_tokens=2048)
        resp = client.models.generate_content(model=model, contents=contents, config=cfg)
        calls = [] if last else (resp.function_calls or [])
        if not calls:
            return (resp.text or "").strip() or None
        contents.append(resp.candidates[0].content)
        parts = []
        for call in calls:
            args = dict(call.args or {})
            out = execute_tool(call.name, args)
            _record(result, call.name, args, out)
            parts.append(types.Part.from_function_response(name=call.name, response={"result": out}))
        contents.append(types.Content(role="user", parts=parts))
    return None


_NON_ANSWER_RE = re.compile(
    r"not available|isn'?t available|unavailable|no information|provided information|"
    r"couldn'?t find|could not find|unable to|cannot find|can'?t find|don'?t have|do not have|"
    r"no (?:relevant )?data|try again later|check back",
    re.IGNORECASE,
)


def looks_like_non_answer(answer: Optional[str]) -> bool:
    """True when a synthesized reply is really 'I have nothing' (e.g. 'live status
    ... is not available in the provided information'), even though no error was
    raised. Long answers are assumed to carry real content."""
    text = (answer or "").strip()
    return not text or (len(text) < 400 and bool(_NON_ANSWER_RE.search(text)))


def _is_transient(exc: Exception) -> bool:
    text = str(exc).upper()
    return "503" in text or "UNAVAILABLE" in text or "OVERLOADED" in text or "529" in text


def is_available() -> bool:
    return bool(os.environ.get("GEMINI_API_KEY", "").strip() or os.environ.get("ANTHROPIC_API_KEY", "").strip())


def run_agent(question: str, extra_instructions: str = "") -> AgentResult:
    """Runs the tool-using agent. Never raises. result.answer is None when no
    provider is configured or every provider failed (see result.error), so the
    caller can fall back to the deterministic pipeline."""
    result = AgentResult()
    _web_sources_this_run.clear()
    system = build_system_prompt(extra_instructions)
    errors = []

    for name, runner in (("gemini", _run_gemini), ("claude", _run_claude)):
        for attempt in range(2):
            try:
                answer = runner(question, system, result)
                if answer:
                    result.answer, result.provider = answer, name
                    result.web_sources = list(_web_sources_this_run)
                    return result
                break  # no key, or empty answer: try the next provider
            except Exception as exc:
                if attempt == 0 and _is_transient(exc):
                    time.sleep(2)
                    continue
                errors.append(f"{name}: {type(exc).__name__}: {exc}")
                break

    result.error = "; ".join(errors) or "no LLM provider configured"
    return result

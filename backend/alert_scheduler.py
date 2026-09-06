"""
alert_scheduler.py
-------------------
FEATURE: Push Notifications for Proactive Alerts — the background job.

This is what actually makes alerts "proactive": everywhere else in this
project, a check only runs because a person opened a tab and triggered
it. This module runs on its own timer (APScheduler, in-process — no
separate worker service to deploy) and walks every watch stored in
push_store.py, regardless of whether anyone has the app open right now.

Dependency-injected on purpose: this module never imports app.py (that
would be circular, since app.py imports this module to start it), so
app.py hands it a plain callable at startup — `predict_fn(train_number,
date) -> Optional[int]` — that wraps the SAME delay-prediction code path
`/api/delay/predict` and the in-app `/api/advanced/alerts/check` already
use. One prediction pipeline, three ways of triggering it (on-demand
single call, on-demand batch, background batch) — never a second,
diverging implementation of "what counts as delayed".

NOTIFICATION DEDUPING: a watch only gets pushed again if the predicted
delay has INCREASED since the last push sent for it (tracked in
push_store's last_notified_delay), not on every single tick it stays
breached — otherwise someone watching a 20-minutes-late train would get
a new notification every 15 minutes for the entire journey. Falling
delay, or delay dropping back under threshold, resets nothing by itself
(next re-breach at a higher number than before will still notify).

HOSTING CAVEAT (stated plainly, not glossed over): this only fires while
the backend process is actually running. A serverless/scale-to-zero host
that spins the process down when idle will silently stop firing this
timer — this needs a host that keeps a long-running process alive (a VM,
a container on an always-on plan, etc.), not a request-triggered
platform. See README.md.
"""

import logging
from typing import Callable, Optional

import push_notifications
import push_store

logger = logging.getLogger("alert_scheduler")
# Python's default logging threshold is WARNING — without this, every
# logger.info() call below (start confirmation, per-tick pass summary)
# is silently dropped unless the app happens to configure logging
# globally. That made the scheduler look inactive in the terminal even
# while it was ticking normally; this guarantees its own output is
# always visible, independent of whatever the rest of the app does.
if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("[alert_scheduler] %(message)s"))
    logger.addHandler(_handler)
    logger.propagate = False
logger.setLevel(logging.INFO)

_scheduler = None
DEFAULT_INTERVAL_MINUTES = 2

# LIVE-TRIGGER DEDUPE: separate from the interval scheduler's own dedup
# (removed there per Round 23's explicit request — that path pushes every
# tick regardless of change). A live-tracking session's websocket ticks
# every few seconds, so pushing on every single tick there would be far
# spammier than the old interval-based behavior ever was. Instead the
# live-trigger path (check_and_push_for_train) only pushes when the
# figure has actually CHANGED since the last push sent for that watch
# (tracked the same way as before, via push_store's last_notified_delay) —
# so a notification fires the moment live tracking's own number moves,
# not on a fixed timer, without re-sending an unchanged figure every tick.


# Sentinel stored in push_store's last_notified_delay (an INTEGER column)
# to dedupe the new "already reached" station-status message, distinct
# from any real delay-minutes value (which is always >= 0) — reuses the
# existing dedupe column instead of a schema change. Once a watch's
# labelled station has been notified as already-reached, this sentinel
# blocks repeat pushes for it (unlike delay breaches, which per Round 23
# intentionally DO repeat every tick — this is a one-time event, not an
# ongoing breach, so the two shouldn't share that behavior).
_ALREADY_REACHED_SENTINEL = -1


def _push_one(w: dict, delay: int, predicted_station: Optional[str]) -> dict:
    """
    Shared send-and-record step for a single breached watch. Used by both
    the interval scheduler (run_check_once) and the live-tracking trigger
    (check_and_push_for_train) so there is exactly one place that actually
    calls send_delay_alert and marks a watch as notified.
    """
    result = push_notifications.send_delay_alert(
        token=w["token"],
        train_number=w["train_number"],
        label=w.get("label"),
        predicted_delay_minutes=delay,
        predicted_for_station=predicted_station,
    )
    if result["sent"]:
        push_store.mark_notified(w["id"], delay)
    else:
        logger.warning("Push failed for watch id=%s: %s", w["id"], result["error"])
        # A token can go permanently dead (browser data cleared, app
        # uninstalled, a stale/duplicate token from earlier testing) —
        # Firebase reports that as "unregistered"/"not found" rather
        # than a transient error. Without cleanup, that watch fails
        # identically forever. This removes the dead token and every
        # watch tied to it so future passes stop wasting a send on it;
        # the device will simply re-register with a fresh token next
        # time it enables push, same as any first-time signup.
        error_text = (result["error"] or "").lower().replace(" ", "").replace("-", "")
        if "notregistered" in error_text or "notfound" in error_text or "invalidregistration" in error_text:
            logger.info("Removing dead token (watch id=%s) — device is no longer reachable.", w["id"])
            push_store.unregister_token(w["token"])
    return result


def _push_station_status(w: dict, station: Optional[str], message: str, actual_time: Optional[str]) -> dict:
    """
    Send-and-record step for the "already reached" station-status message
    (see _predict_for_watch_station in app.py) — separate from _push_one
    since this isn't a delay-threshold breach, it's a one-time "this
    station is already at HH:MM" notice. Dedupes via the
    _ALREADY_REACHED_SENTINEL stored in last_notified_delay so it doesn't
    repeat every scheduler tick the way delay breaches intentionally do.
    """
    result = push_notifications.send_station_status_alert(
        token=w["token"], train_number=w["train_number"], label=w.get("label"),
        station=station, message=message, actual_time=actual_time,
    )
    if result["sent"]:
        push_store.mark_notified(w["id"], _ALREADY_REACHED_SENTINEL)
    else:
        logger.warning("Station-status push failed for watch id=%s: %s", w["id"], result["error"])
    return result


def _resolve_prediction(predict_fn, w: dict):
    """
    Normalizes whatever predict_fn returns into (status, delay, station,
    message, actual_time). Accepts the new label-aware dict contract
    (see app.py's _predict_for_watch_station: {"status", "delay_minutes",
    "station", "message", "actual_time"}) as well as the older bare-int
    or (delay, station) tuple contracts, so any test double or older
    predict_fn passed in directly still works unchanged.
    """
    result = predict_fn(w["train_number"], w.get("date"), w.get("label"))
    if isinstance(result, dict):
        return (result.get("status", "predicted"), result.get("delay_minutes"),
                result.get("station"), result.get("message"), result.get("actual_time"))
    if isinstance(result, tuple):
        delay, station = result
        return ("predicted" if delay is not None else "unavailable", delay, station, None, None)
    return ("predicted" if result is not None else "unavailable", result, None, None, None)


def run_check_once(predict_fn: Callable[[str, Optional[str]], "tuple[Optional[int], Optional[str]]"]) -> dict:
    """
    One full pass over every stored watch. Exposed as its own function
    (not just the scheduler's job body) so it can also be triggered
    manually via a debug endpoint or a test, without waiting for the timer.
    """
    watches = push_store.list_all_watches_with_tokens()
    checked, breached, pushed, push_failed = 0, 0, 0, 0

    for w in watches:
        checked += 1
        try:
            status, delay, predicted_station, message, actual_time = _resolve_prediction(predict_fn, w)
        except Exception as e:  # noqa: BLE001 - one bad watch shouldn't kill the pass
            logger.warning("Prediction failed for watch id=%s train=%s: %s", w["id"], w["train_number"], e)
            continue

        # LABEL-AWARE OUTCOMES (see app.py's _predict_for_watch_station):
        # a watch whose label doesn't match a real station on this train's
        # route gets no notification at all (not a delay, just an invalid
        # watch) — same for "unavailable" (no live data to go on yet).
        if status in ("not_on_route", "unavailable"):
            continue
        if status == "already_reached":
            breached += 1
            last_notified = w.get("last_notified_delay")
            if last_notified == _ALREADY_REACHED_SENTINEL:
                continue  # already told this device this station was reached
            result = _push_station_status(w, predicted_station, message or "", actual_time)
            if result["sent"]:
                pushed += 1
            else:
                push_failed += 1
            continue

        if delay is None or delay < w["threshold_minutes"]:
            continue
        breached += 1

        # NOTE: this used to skip re-sending unless the delay got WORSE than
        # the last notification, to avoid an identical alert every tick for
        # as long as a train stayed delayed. Per explicit request, that gate
        # is now removed — every tick a watch is breached, it pushes again,
        # for as long as ALERT_CHECK_INTERVAL_MINUTES keeps firing. This is
        # intentionally more frequent/spammier than before; if that turns
        # out to be too noisy in practice, the old "only on increase" gate
        # is just these three lines, easy to restore:
        #   last_notified = w.get("last_notified_delay")
        #   if last_notified is not None and delay <= last_notified:
        #       continue

        result = _push_one(w, delay, predicted_station)
        if result["sent"]:
            pushed += 1
        else:
            push_failed += 1

    summary = {"checked": checked, "breached": breached, "pushed": pushed, "push_failed": push_failed}
    logger.info("Alert scheduler pass: %s", summary)
    return summary


def check_and_push_for_train(train_number: str, date: Optional[str], delay: Optional[int],
                              predicted_station: Optional[str]) -> dict:
    """
    LIVE-TRACKING TRIGGER: called from the Live Train Tracking websocket
    loop (app.py's ws_track_train) every time it computes a fresh
    per-reporting-station prediction for a train someone actually has
    open right now — the same figure the in-app headline/per-station list
    just displayed. This is what makes a push notification track the
    live tracker in near-real-time instead of only refreshing on
    ALERT_CHECK_INTERVAL_MINUTES's fixed timer, which is what caused a
    notification to visibly lag behind (and disagree with) the open
    tracking tab.

    Deliberately separate from run_check_once's own dedupe behavior (see
    module docstring above): pushes only when `delay` differs from the
    watch's last_notified_delay, since this can be called every few
    seconds while a tracking session is open.
    """
    if delay is None:
        return {"checked": 0, "breached": 0, "pushed": 0, "push_failed": 0}

    watches = push_store.list_watches_for_train(train_number)
    checked, breached, pushed, push_failed = 0, 0, 0, 0

    for w in watches:
        checked += 1
        if delay < w["threshold_minutes"]:
            continue
        breached += 1

        last_notified = w.get("last_notified_delay")
        if last_notified is not None and delay == last_notified:
            continue  # figure hasn't actually changed since the last push — nothing new to say

        result = _push_one(w, delay, predicted_station)
        if result["sent"]:
            pushed += 1
        else:
            push_failed += 1

    if pushed:
        logger.info(
            "Live-trigger push for train=%s date=%s delay=%s station=%s: %s",
            train_number, date, delay, predicted_station,
            {"checked": checked, "breached": breached, "pushed": pushed, "push_failed": push_failed},
        )
    return {"checked": checked, "breached": breached, "pushed": pushed, "push_failed": push_failed}


# =============================================================================
# FEATURE: Fare & Availability "Alert Zone" — the fare-watch background
# check. Mirrors run_check_once's structure exactly (one pass over every
# stored fare_watches row, dependency-injected fare_check_fn so this
# module still never imports app.py), but the breach condition and dedupe
# are different: a delay watch breaches on a threshold crossing and
# (per Round 23) re-pushes every tick; a fare watch breaches on a REAL
# fare drop vs. its own baseline_fare, or a REAL availability-status
# improvement (WL -> RAC -> AVAILABLE), and dedupes on the actual new
# value so it doesn't repeat an identical alert every tick the way delay
# watches now intentionally do — a fare that's already dropped and stayed
# there isn't new information the way "still 20 min late" arguably is.
# =============================================================================
_STATUS_RANK = {"WL": 0, "RAC": 1, "AVAILABLE": 2}
DEFAULT_FARE_CHECK_INTERVAL_MINUTES = 30


def run_fare_check_once(fare_check_fn: Callable[[str, str, str, Optional[str], str, str], dict]) -> dict:
    """
    One full pass over every stored fare watch. `fare_check_fn(train_number,
    source, dest, date, travel_class, quota) -> {"fare": float|None,
    "status_text": str|None, "status_kind": "AVAILABLE"|"RAC"|"WL"|None}` —
    the same real railway_api.get_fare/get_seat_availability calls the
    Fare Heatmap tool itself makes, just invoked on a timer. Exposed as its
    own function (not just the scheduler's job body) so it can be
    triggered manually / from a test without waiting for the timer.
    """
    watches = push_store.list_all_fare_watches_with_tokens()
    checked, breached, pushed, push_failed = 0, 0, 0, 0

    for w in watches:
        checked += 1
        try:
            result = fare_check_fn(w["train_number"], w["source"], w["dest"], w.get("date"), w["travel_class"], w["quota"])
        except Exception as e:  # noqa: BLE001 - one bad watch shouldn't kill the pass
            logger.warning("Fare check failed for watch id=%s train=%s: %s", w["id"], w["train_number"], e)
            continue
        if not isinstance(result, dict):
            continue

        new_fare = result.get("fare")
        status_text = result.get("status_text")
        status_kind = result.get("status_kind")
        baseline_fare = w.get("baseline_fare")
        threshold_pct = w.get("threshold_pct") or 10

        reason = None
        # Real fare drop vs. this watch's own real baseline, past the
        # threshold, and lower than the last value already pushed for it
        # (so a fare that stays down doesn't re-alert every tick).
        if new_fare is not None and baseline_fare:
            drop_pct = 100.0 * (baseline_fare - new_fare) / baseline_fare
            if drop_pct >= threshold_pct:
                last_notified_fare = w.get("last_notified_fare")
                if last_notified_fare is None or new_fare < last_notified_fare:
                    reason = "fare_drop"

        # Real availability-status improvement (WL -> RAC -> AVAILABLE),
        # dedupe on the actual rank so it only fires again on a further
        # real improvement, not on every tick the status stays the same.
        # IMPORTANT: only compares against a PRIOR real observation
        # (last_notified_status) — a watch with no prior observation yet
        # has nothing to have "improved" from, so the very first pass just
        # silently records the current status as the baseline rather than
        # claiming an improvement that didn't actually happen.
        last_status = w.get("last_notified_status")
        if reason is None and status_kind in _STATUS_RANK:
            if last_status is None:
                push_store.mark_fare_notified(w["id"], w.get("last_notified_fare"), status_kind)
            elif _STATUS_RANK[status_kind] > _STATUS_RANK.get(last_status, -1):
                reason = "status_improve"

        if reason is None:
            continue
        breached += 1

        result_push = push_notifications.send_fare_alert(
            token=w["token"], train_number=w["train_number"], label=w.get("label"),
            source=w["source"], dest=w["dest"], travel_class=w["travel_class"],
            old_fare=baseline_fare, new_fare=new_fare, status_text=status_text, reason=reason,
        )
        if result_push["sent"]:
            push_store.mark_fare_notified(w["id"], new_fare if new_fare is not None else baseline_fare, status_kind)
            pushed += 1
        else:
            push_failed += 1
            logger.warning("Fare push failed for watch id=%s: %s", w["id"], result_push["error"])
            error_text = (result_push["error"] or "").lower().replace(" ", "").replace("-", "")
            if "notregistered" in error_text or "notfound" in error_text or "invalidregistration" in error_text:
                push_store.unregister_token(w["token"])

    summary = {"checked": checked, "breached": breached, "pushed": pushed, "push_failed": push_failed}
    logger.info("Fare alert scheduler pass: %s", summary)
    return summary


# =============================================================================
# FEATURE: Background-surviving Smart Alarm. Mirrors the fare-watch block
# above structurally, but the breach condition is `alarm_now` (computed by
# smart_features.smart_alarm_check via the injected alarm_check_fn — the
# SAME real live-position-driven check the in-tab alarm already polls) and
# it's a ONE-SHOT notification, not a repeating one: once fired, the watch
# row is marked `fired` and never checked again (see push_store.mark_alarm_fired).
# `already_passed` also retires the watch without a push — the destination
# was reached before the alarm ever became due (e.g. armed too late, or
# lead_minutes/lead_km too small), so there is nothing useful left to alarm.
# =============================================================================
DEFAULT_ALARM_CHECK_INTERVAL_MINUTES = 2


def _push_alarm(w: dict, result: dict) -> dict:
    """Shared send-and-record step for one due alarm watch. Used by both
    run_alarm_check_once and check_and_push_alarm_for_train."""
    push_result = push_notifications.send_alarm_alert(
        token=w["token"], train_number=w["train_number"], label=w.get("label"),
        station=w["station"], lead_minutes=w["lead_minutes"],
        eta_text=result.get("predicted_arrival") or (result.get("eta_iso") or "")[11:16] or None,
        delay_text=(f"+{result['delay_minutes']} min" if result.get("delay_minutes") else None),
    )
    if push_result["sent"]:
        push_store.mark_alarm_fired(w["id"])
    else:
        logger.warning("Alarm push failed for watch id=%s: %s", w["id"], push_result["error"])
        error_text = (push_result["error"] or "").lower().replace(" ", "").replace("-", "")
        if "notregistered" in error_text or "notfound" in error_text or "invalidregistration" in error_text:
            logger.info("Removing dead token (alarm watch id=%s) — device is no longer reachable.", w["id"])
            push_store.unregister_token(w["token"])
    return push_result


def run_alarm_check_once(alarm_check_fn: Callable[[str, str, Optional[str], float], dict]) -> dict:
    """
    One full pass over every stored, not-yet-fired alarm watch. `alarm_check_fn`
    is `(train_number, station, date, lead_minutes) -> dict` — the same
    shape smart_features.smart_alarm_check returns (see app.py's
    _alarm_check_for_watch, which wraps it with the predicted-delay lookup
    exactly like /api/advanced/smart-alarm does). Exposed as its own
    function so it can also be triggered manually / from a test.
    """
    watches = push_store.list_all_alarm_watches_with_tokens()
    checked, due, pushed, push_failed = 0, 0, 0, 0

    for w in watches:
        checked += 1
        try:
            result = alarm_check_fn(w["train_number"], w["station"], w.get("date"), w["lead_minutes"])
        except Exception as e:  # noqa: BLE001 - one bad watch shouldn't kill the pass
            logger.warning("Alarm check failed for watch id=%s train=%s: %s", w["id"], w["train_number"], e)
            continue
        if not result or not result.get("found"):
            continue
        if result.get("already_passed"):
            # Nothing to alarm any more — retire the watch quietly.
            push_store.mark_alarm_fired(w["id"])
            continue
        if not result.get("alarm_now"):
            continue
        due += 1
        push_result = _push_alarm(w, result)
        if push_result["sent"]:
            pushed += 1
        else:
            push_failed += 1

    summary = {"checked": checked, "due": due, "pushed": pushed, "push_failed": push_failed}
    logger.info("Alarm scheduler pass: %s", summary)
    return summary


def check_and_push_alarm_for_train(train_number: str, date: Optional[str],
                                    alarm_check_fn: Callable[[str, str, Optional[str], float], dict]) -> dict:
    """
    LIVE-TRACKING TRIGGER (mirrors check_and_push_for_train): called from the
    Live Train Tracking websocket loop (app.py's ws_track_train) every tick,
    so a background-registered alarm for a train someone has open right now
    fires the moment the live ETA says it's due, instead of waiting for
    DEFAULT_ALARM_CHECK_INTERVAL_MINUTES's next tick. Cheap when there are no
    alarm watches for this train (list_alarm_watches_for_train is an indexed
    lookup, and the loop only calls alarm_check_fn per MATCHING watch, not
    per poll unconditionally).
    """
    watches = push_store.list_alarm_watches_for_train(train_number)
    if not watches:
        return {"checked": 0, "due": 0, "pushed": 0, "push_failed": 0}
    checked, due, pushed, push_failed = 0, 0, 0, 0

    for w in watches:
        checked += 1
        try:
            result = alarm_check_fn(train_number, w["station"], w.get("date") or date, w["lead_minutes"])
        except Exception as e:  # noqa: BLE001
            logger.warning("Live-trigger alarm check failed for watch id=%s: %s", w["id"], e)
            continue
        if not result or not result.get("found"):
            continue
        if result.get("already_passed"):
            push_store.mark_alarm_fired(w["id"])
            continue
        if not result.get("alarm_now"):
            continue
        due += 1
        push_result = _push_alarm(w, result)
        if push_result["sent"]:
            pushed += 1
        else:
            push_failed += 1

    if pushed:
        logger.info("Live-trigger alarm push for train=%s date=%s: %s", train_number, date,
                     {"checked": checked, "due": due, "pushed": pushed, "push_failed": push_failed})
    return {"checked": checked, "due": due, "pushed": pushed, "push_failed": push_failed}


def start(
    predict_fn: Callable[[str, Optional[str]], Optional[int]], interval_minutes: int = DEFAULT_INTERVAL_MINUTES,
    fare_check_fn: Optional[Callable[[str, str, str, Optional[str], str, str], dict]] = None,
    fare_check_interval_minutes: int = DEFAULT_FARE_CHECK_INTERVAL_MINUTES,
    alarm_check_fn: Optional[Callable[[str, str, Optional[str], float], dict]] = None,
    alarm_check_interval_minutes: int = DEFAULT_ALARM_CHECK_INTERVAL_MINUTES,
):
    """
    Starts the background job(s). Safe to call even if firebase-admin/
    APScheduler aren't installed or Firebase isn't configured — in that
    case the job still runs on schedule but every push attempt inside it
    reports sent=False with a clear reason (see push_notifications.py),
    so nothing crashes and the in-app alert-checking tab is unaffected.

    `fare_check_fn` is optional (not every caller/test needs the fare-watch
    job) — when given, a second interval job runs run_fare_check_once on
    its own (longer, fares move less often than live delay) cadence,
    sharing the same BackgroundScheduler instance/lifecycle as the delay job.
    """
    global _scheduler
    try:
        from apscheduler.schedulers.background import BackgroundScheduler
    except ImportError:
        logger.warning("APScheduler isn't installed — background push checks are disabled (run: pip install APScheduler). "
                        "In-app alert checking (/api/advanced/alerts/check) still works normally.")
        return None

    _scheduler = BackgroundScheduler(daemon=True)
    _scheduler.add_job(
        run_check_once,
        args=[predict_fn],
        trigger="interval",
        minutes=interval_minutes,
        id="delay_alert_push_check",
        max_instances=1,     # never overlap a slow pass with the next tick
        coalesce=True,
        # APScheduler's default grace window is 1 second — a CPU-heavy request
        # elsewhere in the app (delay prediction inference, embedding search)
        # can easily hold Python's GIL longer than that, which otherwise makes
        # APScheduler skip the run entirely instead of just running it a bit
        # late. 5 minutes of slack comfortably covers that without meaningfully
        # delaying real alerts.
        misfire_grace_time=300,
    )
    if fare_check_fn is not None:
        _scheduler.add_job(
            run_fare_check_once,
            args=[fare_check_fn],
            trigger="interval",
            minutes=fare_check_interval_minutes,
            id="fare_alert_push_check",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
        )
    if alarm_check_fn is not None:
        _scheduler.add_job(
            run_alarm_check_once,
            args=[alarm_check_fn],
            trigger="interval",
            minutes=alarm_check_interval_minutes,
            id="smart_alarm_push_check",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
        )
    _scheduler.start()
    logger.info(
        "Alert scheduler started — delay checks every %s minute(s)%s%s.",
        interval_minutes,
        f", fare checks every {fare_check_interval_minutes} minute(s)" if fare_check_fn is not None else " (fare checks disabled)",
        f", alarm checks every {alarm_check_interval_minutes} minute(s)" if alarm_check_fn is not None else " (alarm checks disabled)",
    )
    return _scheduler


def stop():
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None

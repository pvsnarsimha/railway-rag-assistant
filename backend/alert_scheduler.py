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

NOTIFICATION DEDUPING: each watch carries its OWN repeat cadence
(push_store's repeat_minutes column, set from DelayAlertModal's "Repeat
the alert every" picker on Live Tracking — see LiveTrackingScreen.web.js).
A breached watch re-pushes once at least repeat_minutes has elapsed since
the last push sent for it (push_store's last_notified_at), not on every
single scheduler tick — otherwise someone on a 10-minute repeat setting
would get a new notification every ALERT_CHECK_INTERVAL_MINUTES instead
of every 10 minutes as they actually asked for. This has gone through two
earlier designs, in case either needs restoring: "only re-notify if the
delay INCREASED" (too quiet — a steady delay never re-alerted) and later
"push on every tick regardless" (too spammy, and not user-controllable).
The time-based gate below replaces both. Falling delay, or delay dropping
back under threshold, resets nothing by itself (the next re-breach just
follows the same repeat_minutes cadence from wherever last_notified_at
was left).

HOSTING CAVEAT (stated plainly, not glossed over): this only fires while
the backend process is actually running. A serverless/scale-to-zero host
that spins the process down when idle will silently stop firing this
timer — this needs a host that keeps a long-running process alive (a VM,
a container on an always-on plan, etc.), not a request-triggered
platform. See README.md.
"""

import logging
import time
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


def _push_station_status(w: dict, station: Optional[str], message: str, actual_time: Optional[str],
                         running: Optional[dict] = None) -> dict:
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
        station=station, message=message, actual_time=actual_time, running=running,
    )
    if result["sent"]:
        push_store.mark_notified(w["id"], _ALREADY_REACHED_SENTINEL)
    else:
        logger.warning("Station-status push failed for watch id=%s: %s", w["id"], result["error"])
    return result


# Scheduler ticks never land exactly on a repeat boundary (a pass takes a
# few seconds, APScheduler jitters), so a strict "elapsed >= 10 min" check
# on a 2-minute tick would read 9m58s at the 10-min tick and slip the push
# to the 12-min tick. This slack lets a 10/20/30-min repeat fire on the
# tick nearest its boundary instead of one tick late.
_REPEAT_SLACK_SECONDS = 45


def _repeat_due(w: dict) -> bool:
    last_notified_at = w.get("last_notified_at")
    if last_notified_at is None:
        return True
    repeat_minutes = w.get("repeat_minutes") or w["threshold_minutes"]
    return (time.time() - last_notified_at) >= repeat_minutes * 60 - _REPEAT_SLACK_SECONDS


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
                result.get("station"), result.get("message"), result.get("actual_time"),
                result.get("running"), result)
    if isinstance(result, tuple):
        delay, station = result
        return ("predicted" if delay is not None else "unavailable", delay, station, None, None, None, {})
    return ("predicted" if result is not None else "unavailable", result, None, None, None, None, {})


# FEATURE: "10 min before, tell me the train is about to arrive — be alert".
# Fires ONCE per bell (push_store.approach_notified_at) as soon as the live,
# physics-checked ETA to that bell's station drops to this many minutes.
APPROACH_ALERT_MINUTES = 10
# Only announce an arrival as "just reached" when it really happened
# recently; an old arrival (bell armed late, app reopened hours later) just
# switches the bell off silently.
REACHED_NOTICE_WINDOW_MINUTES = 45


def _arrival_is_recent(actual_time: Optional[str]) -> bool:
    import running_status  # local import: keeps this module importable in isolation
    ahead = running_status.clock_minutes_ahead(actual_time, running_status.ist_now())
    return ahead is not None and -REACHED_NOTICE_WINDOW_MINUTES <= ahead <= 5


def _retire_reached_watch(w: dict, station: Optional[str], actual_time: Optional[str],
                          running: Optional[dict]) -> bool:
    """FEATURE: bell auto-off. The train has really reached this bell's
    station: send one final "reached — alert switched off" notice (only if
    the arrival is recent and this device wasn't already told), then retire
    the watch so no further notification is ever sent for it. Returns True
    when a push was sent."""
    sent = False
    if w.get("last_notified_delay") != _ALREADY_REACHED_SENTINEL and _arrival_is_recent(actual_time):
        import running_status
        clock = running_status._hhmm(actual_time)
        name = running_status._title(station) or station or (w.get("label") or "your station")
        msg = f"Reached {name}" + (f" at {clock}" if clock else "") + " · this station's alert is now switched off."
        res = push_notifications.send_station_status_alert(
            token=w["token"], train_number=w["train_number"], label=None,
            station=station, message=msg, actual_time=actual_time, running=running,
        )
        sent = bool(res.get("sent"))
    try:
        push_store.retire_watch(w)
    except Exception as e:  # noqa: BLE001
        logger.warning("Couldn't retire watch id=%s: %s", w.get("id"), e)
    return sent


def _push_approach(w: dict, extra: dict, delay: Optional[int], station: Optional[str],
                   running: Optional[dict]) -> bool:
    res = push_notifications.send_approach_alert(
        token=w["token"], train_number=w["train_number"], station=station or w.get("label"),
        minutes=extra.get("minutes_to_arrival"), eta_text=extra.get("predicted_eta"),
        km=extra.get("km_to_station"), delay_minutes=delay, running=running,
    )
    if res.get("sent"):
        push_store.mark_approach_notified(w["id"])
        return True
    logger.warning("Approach push failed for watch id=%s: %s", w["id"], res.get("error"))
    return False


def run_check_once(predict_fn: Callable[[str, Optional[str]], "tuple[Optional[int], Optional[str]]"]) -> dict:
    """
    One full pass over every stored watch. Exposed as its own function
    (not just the scheduler's job body) so it can also be triggered
    manually via a debug endpoint or a test, without waiting for the timer.
    """
    watches = push_store.list_all_watches_with_tokens()
    checked, breached, pushed, push_failed = 0, 0, 0, 0
    groups = {}
    # Many users (or one user on several devices) can watch the SAME train
    # + station — look each (train, date, station) up once per pass and
    # share the result, instead of one live-status fetch per watch.
    prediction_cache = {}
    running_by_train = {}

    for w in watches:
        checked += 1
        try:
            cache_key = (str(w["train_number"]), w.get("date"), (w.get("label") or "").strip().upper())
            if cache_key not in prediction_cache:
                prediction_cache[cache_key] = _resolve_prediction(predict_fn, w)
            status, delay, predicted_station, message, actual_time, running, extra = prediction_cache[cache_key]
        except Exception as e:  # noqa: BLE001 - one bad watch shouldn't kill the pass
            logger.warning("Prediction failed for watch id=%s train=%s: %s", w["id"], w["train_number"], e)
            continue

        # DIAGNOSTIC: the pass-level summary alone doesn't say WHY a watch
        # didn't count as breached — a delay that's None, a status that
        # skipped it outright, or a real delay that's just under this
        # watch's own threshold all look identical from the outside
        # (breached stays 0). This makes that visible per-watch instead of
        # having to guess between "scheduler isn't finding this watch",
        # "prediction disagrees with what Live Tracking shows", and "it's
        # genuinely under threshold".
        _last = w.get("last_notified_at")
        logger.info(
            "watch id=%s token=…%s train=%s date=%s label=%s -> status=%s delay=%s threshold=%s repeat=%s "
            "last_push=%s station=%s",
            w["id"], str(w.get("token") or "")[-6:], w["train_number"], w.get("date"), w.get("label"),
            status, delay, w["threshold_minutes"], w.get("repeat_minutes"),
            (f"{round((time.time() - _last) / 60, 1)}min ago" if _last else "never"), predicted_station,
        )

        # LABEL-AWARE OUTCOMES (see app.py's _predict_for_watch_station):
        # a watch whose label doesn't match a real station on this train's
        # route gets no notification at all (not a delay, just an invalid
        # watch) — same for "unavailable" (no live data to go on yet).
        if status == "journey_completed":
            # Whole run is over — nothing left to alert on for this bell.
            try:
                push_store.retire_watch(w)
            except Exception:  # noqa: BLE001
                pass
            continue
        if status in ("not_on_route", "unavailable"):
            continue
        if status == "already_reached":
            # BUGFIX / FEATURE (bell auto-off): once the train reaches a
            # bell's station the bell switches itself off — one final
            # "Reached X at HH:MM" notice (only if it just happened), then
            # the watch is retired so NO further notification is sent for
            # it, even if the device later re-syncs its old local list.
            breached += 1
            if _retire_reached_watch(w, predicted_station, actual_time, running):
                logger.info("PUSH sent (reached, bell auto-off) watch id=%s train=%s station=%s",
                            w["id"], w["train_number"], predicted_station)
                pushed += 1
            else:
                logger.info("Bell auto-off (silent) watch id=%s train=%s station=%s",
                            w["id"], w["train_number"], predicted_station)
            continue

        # FEATURE: "train about to arrive in the next ~10 min — be alert".
        minutes_to_arrival = (extra or {}).get("minutes_to_arrival")
        if (status == "predicted" and w.get("label") and minutes_to_arrival is not None
                and 0 <= minutes_to_arrival <= APPROACH_ALERT_MINUTES and not w.get("approach_notified_at")):
            if _push_approach(w, extra, delay, predicted_station, running):
                pushed += 1
                push_store.mark_notified(w["id"], delay if delay is not None else 0)
                logger.info("PUSH sent (arriving in ~%s min) watch id=%s train=%s station=%s",
                            minutes_to_arrival, w["id"], w["train_number"], predicted_station)
                continue  # the approach notice already carries the delay — no second push this tick
            push_failed += 1

        if delay is None or delay < w["threshold_minutes"]:
            continue
        breached += 1
        # Collected, not pushed yet — see the grouping pass below.
        groups.setdefault((w["token"], w["train_number"], w.get("date")), []).append((w, delay, predicted_station, extra or {}))
        running_by_train[(str(w["train_number"]), w.get("date"))] = running

    # BUGFIX ("notification every 2 minutes after I closed the app"): each
    # per-station bell is its own watch with its own repeat clock. Several
    # stations on one train breach at DIFFERENT ticks (downstream delays
    # grow as the prediction updates), so their 10-min clocks started 2, 4,
    # 6... min apart and the pushes interleaved into one every scheduler
    # tick. Breached watches are now grouped per (device, train, date):
    # ONE notification naming every breached station, gated by the group's
    # shortest repeat_minutes against its most recent push, and every watch
    # in the group is marked notified together so their clocks stay in step.
    for (_token, train_number, _date), items in groups.items():
        watches_in_group = [it[0] for it in items]
        last_times = [w.get("last_notified_at") for w in watches_in_group if w.get("last_notified_at")]
        repeat = min((w.get("repeat_minutes") or w["threshold_minutes"]) for w in watches_in_group)
        if last_times and not _repeat_due({"last_notified_at": max(last_times), "repeat_minutes": repeat,
                                           "threshold_minutes": repeat}):
            continue
        items.sort(key=lambda it: -it[1])
        head_w, head_delay, head_station, head_extra = items[0]
        summary_text = None
        if len(items) > 1:
            summary_text = ", ".join(f"{(st or 'next stop').title()} ~{d} min" for _w, d, st, _x in items[:4])
            if len(items) > 4:
                summary_text += f" +{len(items) - 4} more"
        result = push_notifications.send_delay_alert(
            token=head_w["token"], train_number=train_number, label=head_w.get("label"),
            predicted_delay_minutes=head_delay, predicted_for_station=head_station,
            stations_summary=summary_text,
            running=running_by_train.get((str(train_number), _date)),
            eta_text=head_extra.get("predicted_eta"), minutes_to_arrival=head_extra.get("minutes_to_arrival"),
            km_to_station=head_extra.get("km_to_station"),
        )
        if result["sent"]:
            pushed += 1
            for w, d, _st, _x in items:
                push_store.mark_notified(w["id"], d)
            logger.info("PUSH sent train=%s stations=%s next in %s min",
                        train_number, [st for _w, _d, st, _x in items], repeat)
        else:
            push_failed += 1
            logger.warning("Push failed for train=%s watches=%s: %s",
                           train_number, [w["id"] for w in watches_in_group], result["error"])
            error_text = (result["error"] or "").lower().replace(" ", "").replace("-", "")
            if "notregistered" in error_text or "notfound" in error_text or "invalidregistration" in error_text:
                push_store.unregister_token(head_w["token"])

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

    Shares run_check_once's own repeat-cadence gate (see module docstring
    above) rather than a separate "only when the number changes" rule —
    this can be called every few seconds while a tracking session is
    open, and the point of repeat_minutes is a predictable cadence either
    way it fires from, not a faster heartbeat just because a tab happens
    to be open. Reading and writing the SAME last_notified_at as
    run_check_once also means the two paths cooperate correctly if both
    are live for the same watch at once: whichever pushes first sets
    last_notified_at, and the other's gate check then holds off too.
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

        if not _repeat_due(w):
            continue

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


# =============================================================================
# FEATURE: background Live Tracking (RailYatri-style) — keeps tracking the
# train the user had open even after they close/exit the app. Each device's
# tracking_watches row (registered by the Live Tracking screen on "Start
# tracking", removed on "Stop") gets a SILENT running-status push that
# replaces the same per-train notification in place:
#     "12625 Kerala Exp · 15 min late"
#     "Crossed Aluva at 17:54 · 26 km to Thrissur"
#     "Next halt Thrissur exp. 17:43 (15 min late)"
# A push only goes out when the train has really moved on (see
# running_status.signature) or every TRACKING_REFRESH_MINUTES as a slow
# heartbeat on web (Expo/native only on real change — Expo can't replace a
# notification in place, so a heartbeat there would stack duplicates).
# The watch retires itself with one final "Reached <destination>" push.
# =============================================================================
DEFAULT_TRACKING_CHECK_INTERVAL_MINUTES = 2
TRACKING_REFRESH_MINUTES = 10


def run_tracking_check_once(status_fn: Callable[[str, Optional[str]], dict]) -> dict:
    """`status_fn(train_number, date) -> dict` with a "running" snapshot —
    app.py passes a wrapper around _predict_for_watch_station (the SAME
    live pipeline delay alerts use), so this never diverges from them."""
    import running_status  # local import: keeps this module importable in isolation

    watches = push_store.list_all_tracking_watches()
    checked, pushed, push_failed, retired = 0, 0, 0, 0
    cache = {}
    now = time.time()
    for w in watches:
        checked += 1
        key = (str(w["train_number"]), w.get("date"))
        try:
            if key not in cache:
                cache[key] = status_fn(w["train_number"], w.get("date")) or {}
            result = cache[key]
        except Exception as e:  # noqa: BLE001
            logger.warning("Tracking status failed for train=%s: %s", w["train_number"], e)
            continue
        rs = result.get("running")
        if not rs:
            continue
        sig = running_status.signature(rs)
        final = bool(rs.get("completed")) or result.get("status") == "journey_completed"
        changed = sig != (w.get("last_signature") or "")
        is_expo = push_notifications._is_expo_token(w["token"])
        heartbeat_due = (not is_expo) and (
            w.get("last_pushed_at") is None
            or now - w["last_pushed_at"] >= TRACKING_REFRESH_MINUTES * 60 - _REPEAT_SLACK_SECONDS
        )
        if not (changed or heartbeat_due or final):
            continue
        res = push_notifications.send_running_status(w["token"], w["train_number"], rs, final=final)
        if res["sent"]:
            pushed += 1
            if final:
                push_store.delete_tracking_watch_by_id(w["id"])
                retired += 1
            else:
                push_store.mark_tracking_pushed(w["id"], sig)
        else:
            push_failed += 1
            logger.warning("Tracking push failed id=%s: %s", w["id"], res["error"])
            error_text = (res["error"] or "").lower().replace(" ", "").replace("-", "")
            if "notregistered" in error_text or "notfound" in error_text or "invalidregistration" in error_text:
                push_store.unregister_token(w["token"])
    summary = {"checked": checked, "pushed": pushed, "push_failed": push_failed, "retired": retired}
    if checked:
        logger.info("Tracking scheduler pass: %s", summary)
    return summary


def keep_alive_ping() -> None:
    """Render's free plan puts a web service to sleep after ~15 min with no
    INBOUND request — and a sleeping process runs no scheduler, so a closed
    app would stop getting updates. While at least one background tracking
    watch (or alarm) is active, ping our own public URL so the service stays
    awake exactly as long as someone is being tracked, and no longer."""
    import os
    import requests

    url = (os.environ.get("KEEP_ALIVE_URL") or os.environ.get("PUBLIC_APP_URL") or "").strip().rstrip("/")
    if not url.startswith("https://"):
        return
    try:
        active = push_store.count_tracking_watches() + len(push_store.list_all_alarm_watches_with_tokens())
    except Exception:  # noqa: BLE001
        active = 0
    if not active:
        return
    try:
        requests.get(f"{url}/api/health", timeout=20)
    except Exception as e:  # noqa: BLE001
        logger.warning("keep-alive ping failed: %s", e)


def start(
    predict_fn: Callable[[str, Optional[str]], Optional[int]], interval_minutes: int = DEFAULT_INTERVAL_MINUTES,
    fare_check_fn: Optional[Callable[[str, str, str, Optional[str], str, str], dict]] = None,
    fare_check_interval_minutes: int = DEFAULT_FARE_CHECK_INTERVAL_MINUTES,
    alarm_check_fn: Optional[Callable[[str, str, Optional[str], float], dict]] = None,
    alarm_check_interval_minutes: int = DEFAULT_ALARM_CHECK_INTERVAL_MINUTES,
    tracking_status_fn: Optional[Callable[[str, Optional[str]], dict]] = None,
    tracking_interval_minutes: int = DEFAULT_TRACKING_CHECK_INTERVAL_MINUTES,
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
    if tracking_status_fn is not None:
        _scheduler.add_job(
            run_tracking_check_once,
            args=[tracking_status_fn],
            trigger="interval",
            minutes=tracking_interval_minutes,
            id="background_tracking_push",
            max_instances=1,
            coalesce=True,
            misfire_grace_time=300,
        )
        _scheduler.add_job(
            keep_alive_ping, trigger="interval", minutes=10, id="keep_alive_ping",
            max_instances=1, coalesce=True, misfire_grace_time=300,
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
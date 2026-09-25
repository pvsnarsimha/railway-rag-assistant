"""
push_notifications.py
----------------------
FEATURE: Push Notifications for Proactive Alerts — the actual send step.

Uses Firebase Cloud Messaging (FCM) via the `firebase-admin` SDK. FCM
covers Android + web push directly, and iOS through Apple's APNs
transparently as long as the frontend registers via the Firebase JS SDK
(Firebase relays to APNs itself for a native/Expo app — this file never
needs to speak to Apple directly).

SETUP (same "leave it unset and get an honest degraded message" pattern
as every other provider key in this project — see README.md):
  1. Create a Firebase project (console.firebase.google.com) — free.
  2. Project Settings -> Service Accounts -> "Generate new private key".
     Save the downloaded JSON file somewhere OUTSIDE the repo (it's a
     credential) and set FIREBASE_SERVICE_ACCOUNT_JSON in backend/.env
     to its absolute path.
  3. Project Settings -> Cloud Messaging -> Web Push certificates ->
     generate a key pair. That's the VAPID key the FRONTEND needs
     (frontend/app.js's FIREBASE_CONFIG.vapidKey) — separate from the
     backend service-account JSON above.

Nothing else in the app breaks if this is left unconfigured: alert
watches, the in-tab checking endpoint, and everything else still work
exactly as before. Only actual push delivery is skipped, with a clear
note surfaced to the /api/push/* endpoints and printed at startup.
"""

import os
from datetime import datetime, timedelta, timezone


def _ist_now() -> datetime:
    """Train times are IST; Render runs in UTC, so stamp notifications in IST."""
    return datetime.now(timezone.utc) + timedelta(hours=5, minutes=30)
from typing import Optional

import requests

_initialized = False
_init_error: Optional[str] = None

# CROWD-POSITION FOLLOW-UP: the mobile app registers via Expo's push
# service (see mobile-app/src/services/pushNotifications.js) rather than
# a raw FCM/native device token, since that needs no Firebase
# iOS/Android native project to be configured at all — just a free EAS
# project ID. A token in this format is routed to Expo's HTTPS push API
# instead of firebase-admin below; every other token (web's FCM/webpush
# tokens, unchanged) keeps going through Firebase exactly as before.
_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"


def _is_expo_token(token: str) -> bool:
    return token.startswith("ExponentPushToken[") or token.startswith("ExpoPushToken[")


def _send_via_expo(token: str, title: str, body: str, data: dict, sound: Optional[str] = "default") -> dict:
    """Never raises — same never-raises contract as the FCM senders below,
    so alert_scheduler.py can keep going on a per-token failure."""
    try:
        resp = requests.post(
            _EXPO_PUSH_URL,
            json={k: v for k, v in {"to": token, "title": title, "body": body, "data": data,
                                    "sound": sound}.items() if v is not None},
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            timeout=10,
        )
        payload = resp.json() if resp.content else {}
        ticket = (payload.get("data") or {}) if isinstance(payload, dict) else {}
        if isinstance(ticket, list):  # Expo returns a list when {to} was itself a list
            ticket = ticket[0] if ticket else {}
        if ticket.get("status") == "error":
            return {"sent": False, "error": ticket.get("message") or "Expo push API returned an error."}
        if not resp.ok:
            return {"sent": False, "error": f"Expo push API HTTP {resp.status_code}: {resp.text[:200]}"}
        return {"sent": True, "error": None}
    except requests.exceptions.RequestException as e:
        return {"sent": False, "error": f"Expo push API request failed: {e}"}


def _ensure_initialized() -> bool:
    global _initialized, _init_error
    if _initialized:
        return True
    if _init_error is not None:
        return False

    cred_path = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if not cred_path:
        _init_error = (
            "FIREBASE_SERVICE_ACCOUNT_JSON is not set in backend/.env — push notifications "
            "are disabled, but in-app alert checking still works normally."
        )
        return False
    if not os.path.isfile(cred_path):
        _init_error = f"FIREBASE_SERVICE_ACCOUNT_JSON points to a file that doesn't exist: {cred_path}"
        return False

    try:
        import firebase_admin
        from firebase_admin import credentials

        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred)
        _initialized = True
        return True
    except ImportError:
        _init_error = "firebase-admin isn't installed — run: pip install firebase-admin"
        return False
    except Exception as e:  # noqa: BLE001 - surfaced to caller, not swallowed
        _init_error = f"Firebase initialization failed: {e}"
        return False


def status() -> dict:
    """For a diagnostics endpoint / startup log line — never raises.

    `configured` reflects the FCM/webpush path only (what the web app
    uses) since that's the one that needs operator setup (a Firebase
    service account). The Expo push path the mobile app uses needs no
    server-side credentials at all — Expo's relay handles the FCM/APNs
    leg — so it's always available and reported separately here rather
    than folded into `configured`, which would otherwise wrongly read
    "not configured" even when mobile push is fully working.
    """
    ok = _ensure_initialized()
    return {
        "configured": ok,
        "detail": None if ok else _init_error,
        "expo_push_available": True,
        "expo_push_detail": "Mobile push (Expo relay) needs no server-side credentials — see push_notifications.py.",
    }


def _notification_icon_url() -> Optional[str]:
    """Absolute URL for the small icon shown on a background push's banner.
    One backend serves both frontend/ (at "/") and the mobile-app web
    export (at "/mobile-app") from the same host, so one shared icon URL
    works for a push delivered to either origin. Only built once
    PUBLIC_APP_URL points at a real HTTPS deploy — same guard already used
    for the webpush click-through link below, since a bare "/" or
    localhost URL isn't fetchable by whatever service is rendering the
    notification banner."""
    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    if public_url.startswith("https://"):
        return f"{public_url.rstrip('/')}/assets/icons/train-marker.png"
    return None


def _delay_tag(train_number) -> str:
    """BUGFIX ("bell alerts never show, only 'Crossed Eluru'"): delay /
    station alerts used the SAME per-train tag as the silent running-status
    card, so the next silent status update (every few minutes) replaced the
    delay alert in place before it was ever seen. Bell alerts now get their
    own slot, so both stay visible."""
    return f"delay-{train_number}"


def _train_tag(train_number) -> str:
    """ONE notification slot per train (RailYatri-style): delay alerts,
    station-reached notices and the background running-status update all
    replace each other in place instead of stacking up as separate cards."""
    return f"train-{train_number}"


def _webpush_config(title: str, body: str, tag: str, renotify: bool = True, silent: bool = False):
    """
    FEATURE: SMS-style push presentation. A bare WebpushNotification(title,
    body) — what every send_* below used before this — renders as a thin,
    auto-dismissing browser popup, nothing like how a text message alerts
    you. This is the closest a standard web push can get to that:
      - require_interaction: the banner stays up until tapped/dismissed,
        instead of vanishing after a few seconds like a default push.
      - vibrate: a real buzz pattern, same as an SMS arriving.
      - tag + renotify: a second alert for the SAME watch (e.g. the
        predicted delay moved) re-buzzes/re-alerts instead of silently
        overwriting an already-dismissed notification with new text.
      - icon/badge: the app's own icon instead of a bare generic bubble.
    `silent` is deliberately left unset (defaults to False) — the phone's
    own default notification sound still plays. There's no web API to
    swap in a custom ringtone file the way a native Android/iOS app can;
    this is the loudest/most attention-grabbing a browser push gets.
    """
    from firebase_admin import messaging

    icon_url = _notification_icon_url()
    webpush_notification = messaging.WebpushNotification(
        title=title,
        body=body,
        icon=icon_url,
        badge=icon_url,
        tag=tag,
        renotify=renotify,
        silent=silent or None,
        require_interaction=True,
        vibrate=None if silent else [200, 100, 200, 100, 200],
    )
    webpush_kwargs = {"notification": webpush_notification}
    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    if public_url.startswith("https://"):
        webpush_kwargs["fcm_options"] = messaging.WebpushFCMOptions(link=public_url)
    return messaging.WebpushConfig(**webpush_kwargs)


def send_delay_alert(
    token: str, train_number: str, label: Optional[str], predicted_delay_minutes: int,
    predicted_for_station: Optional[str] = None,
    stations_summary: Optional[str] = None,
    running: Optional[dict] = None,
    eta_text: Optional[str] = None,
    minutes_to_arrival: Optional[float] = None,
    km_to_station: Optional[float] = None,
) -> dict:
    """
    Send one push notification for a breached delay-alert watch.
    stations_summary: when several station alerts on the same train are
    breached at once they're sent as ONE notification (see
    alert_scheduler.run_check_once) and this replaces the single-station
    wording, e.g. "Khammam ~27 min, Dornakal Jn ~25 min".
    Returns {"sent": bool, "error": str | None} — callers (the scheduler)
    are expected to keep going on a per-token failure (e.g. an
    uninstalled app / expired token) rather than aborting the whole
    batch, so this never raises.

    predicted_for_station: the real next reporting station
    predicted_delay_minutes is actually FOR (see app.py's api_delay_predict
    SYNC block) — named in the body when known, so the notification reads
    against a real place on the route, not just a bare number, and lines
    up with whatever the watch's own label refers to.
    """
    # Timestamp the notification body with when THIS figure was computed.
    # A push can sit unread for a few minutes after it's sent, and (now
    # that the live-tracking websocket can also trigger a send — see
    # alert_scheduler.check_and_push_for_train) two notifications for the
    # same watch can arrive close together with different numbers as the
    # train's real predicted delay moves — labeling each with its own
    # "as of HH:MM" makes that legible instead of looking like a
    # contradiction or a stale/buggy figure.
    checked_at = _ist_now()
    title = f"Train {train_number} delayed" if (predicted_delay_minutes or 0) > 0 else f"Train {train_number} · on time"
    display_name = f"{train_number}" + (f" — {label}" if label else "")
    station_phrase = f" at {predicted_for_station}" if predicted_for_station else ""
    if stations_summary:
        body = f"Train {train_number} predicted late — {stations_summary} (as of {checked_at.strftime('%H:%M')})."
    else:
        body = (
            (f"{display_name} is now predicted ~{predicted_delay_minutes} min late{station_phrase} "
             if (predicted_delay_minutes or 0) > 0 else f"{display_name} is running on time{station_phrase} ")
            + f"(as of {checked_at.strftime('%H:%M')})."
        )
    # Current, physics-checked ETA to the bell's station — "ETA 04:07 ·
    # 2 km away" rather than a far-off timetable-based time.
    eta_bits = []
    if eta_text:
        eta_bits.append(f"ETA {eta_text}")
    if minutes_to_arrival is not None:
        eta_bits.append("arriving now" if minutes_to_arrival < 1 else f"in ~{int(round(minutes_to_arrival))} min")
    if km_to_station is not None:
        eta_bits.append(f"{km_to_station:g} km away")
    if eta_bits:
        body += f"\n{(predicted_for_station or 'Station').title()}: " + " · ".join(eta_bits)
    # FEATURE (RailYatri-style): lead with WHERE the train is right now —
    # "Crossed Aluva at 17:54 · 26 km to Thrissur" — then the prediction.
    position_line = (running or {}).get("headline")
    if position_line:
        title = f"{train_number}" + (f" {running['train_name']}" if running.get("train_name") else "") \
            + (f" · ~{predicted_delay_minutes} min late" if (predicted_delay_minutes or 0) > 0 else " · on time")
        body = f"{position_line}\n" + body
    data = {
        "type": "delay_alert",
        "train_number": str(train_number),
        "predicted_delay_minutes": str(predicted_delay_minutes),
        "predicted_for_station": predicted_for_station or "",
        "checked_at": checked_at.strftime("%H:%M"),
        "crossed_station": (running or {}).get("crossed_station") or "",
        "next_station": (running or {}).get("next_station") or "",
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    # tag is per-train (not per-watch/station) on purpose: a second delay
    # push for the SAME train while an earlier one is still unread should
    # re-alert in place with the latest number, not pile up as a separate
    # notification the user has to individually clear.
    message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=_delay_tag(train_number)),
    )
    try:
        messaging.send(message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001 - includes expired/unregistered-token errors
        return {"sent": False, "error": str(e)}


def send_fare_alert(
    token: str, train_number: str, label: Optional[str], source: str, dest: str,
    travel_class: str, old_fare: Optional[float], new_fare: Optional[float],
    status_text: Optional[str], reason: str,
) -> dict:
    """
    FEATURE: Fare & Availability "Alert Zone". Send one push notification
    for a fare-watch that just crossed its drop threshold OR whose
    availability status just improved (e.g. WL -> RAC -> AVAILABLE).
    `reason` is "fare_drop" or "status_improve" — same never-raises
    contract as send_delay_alert/send_station_status_alert; callers
    (alert_scheduler) keep going on a per-token failure.
    """
    checked_at = _ist_now()
    display_name = f"{train_number}" + (f" — {label}" if label else "")
    route_phrase = f"{source} → {dest} ({travel_class})"
    if reason == "fare_drop" and old_fare is not None and new_fare is not None:
        title = f"Fare dropped for {train_number}"
        body = f"{display_name} {route_phrase}: fare dropped from ₹{old_fare:.0f} to ₹{new_fare:.0f} (as of {checked_at.strftime('%H:%M')})."
    else:
        title = f"Availability update for {train_number}"
        body = f"{display_name} {route_phrase}: {status_text or 'availability changed'} (as of {checked_at.strftime('%H:%M')})."
    data = {
        "type": "fare_alert",
        "train_number": str(train_number),
        "source": source, "dest": dest, "travel_class": travel_class,
        "reason": reason,
        "old_fare": str(old_fare) if old_fare is not None else "",
        "new_fare": str(new_fare) if new_fare is not None else "",
        "status_text": status_text or "",
        "checked_at": checked_at.strftime("%H:%M"),
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=f"fare_alert-{train_number}-{travel_class}"),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}


def send_alarm_alert(
    token: str, train_number: str, label: Optional[str], station: str,
    lead_minutes: float, eta_text: Optional[str] = None, delay_text: Optional[str] = None,
) -> dict:
    """
    FEATURE: Background-surviving Smart Alarm. Fires once when a server-side
    alarm_watches row's live-predicted arrival at `station` is within
    `lead_minutes` (see alert_scheduler.py's run_alarm_check_once /
    check_and_push_alarm_for_train, which call smart_features.smart_alarm_check
    — the SAME real live-position-driven check the in-tab alarm already uses).
    Same never-raises contract as the other send_* functions here.
    """
    checked_at = _ist_now()
    title = f"⏰ Smart Alarm — {station}"
    display_name = f"{train_number}" + (f" — {label}" if label else "")
    eta_phrase = f" ETA {eta_text}" if eta_text else ""
    delay_phrase = f" ({delay_text})" if delay_text else ""
    body = f"{display_name} is nearing {station}{eta_phrase}{delay_phrase} — get ready! (as of {checked_at.strftime('%H:%M')})"
    data = {
        "type": "smart_alarm",
        "train_number": str(train_number),
        "station": station,
        "lead_minutes": str(lead_minutes),
        "checked_at": checked_at.strftime("%H:%M"),
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=f"smart_alarm-{train_number}-{station}"),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}


def send_approach_alert(
    token: str, train_number: str, station: Optional[str], minutes: Optional[float] = None,
    eta_text: Optional[str] = None, km: Optional[float] = None, delay_minutes: Optional[int] = None,
    running: Optional[dict] = None,
) -> dict:
    """
    FEATURE: "train about to arrive — be alert". Sent ONCE per bell when
    the live, physics-checked ETA to that bell's station drops to ~10 min
    (see alert_scheduler.APPROACH_ALERT_MINUTES). Always alerts (buzz +
    re-notify) — this is the one a passenger waiting on the platform or
    about to get down must not miss. Same never-raises contract.
    """
    checked_at = _ist_now()
    name = " ".join(w.capitalize() if len(w) > 2 else w for w in str(station or "your station").split())
    when = "any moment now" if minutes is not None and minutes < 1 else (
        f"in ~{int(round(minutes))} min" if minutes is not None else "in the next 10 min")
    title = f"🚆 {train_number} arriving at {name} {when}"
    bits = []
    if eta_text:
        bits.append(f"ETA {eta_text}")
    if km is not None:
        bits.append(f"{km:g} km away")
    if delay_minutes is not None:
        bits.append("on time" if delay_minutes <= 0 else f"{delay_minutes} min late")
    body = f"Please be alert — the train will reach {name} in the next 5–10 minutes."
    if bits:
        body += "\n" + " · ".join(bits)
    if (running or {}).get("headline"):
        body = f"{running['headline']}\n{body}"
    body += f"\n(as of {checked_at.strftime('%H:%M')})"
    data = {
        "type": "approach_alert", "train_number": str(train_number), "station": station or "",
        "eta": eta_text or "", "minutes": "" if minutes is None else str(int(round(minutes))),
        "checked_at": checked_at.strftime("%H:%M"),
    }
    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data, sound="default")
    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}
    from firebase_admin import messaging
    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=f"approach-{train_number}-{station or ''}"),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}


def send_station_status_alert(
    token: str, train_number: str, label: Optional[str], station: Optional[str],
    message: str, actual_time: Optional[str] = None, running: Optional[dict] = None,
) -> dict:
    """
    FEATURE: label-aware delay alerts — the "already reached" notice.
    Separate from send_delay_alert (a delay-threshold breach) on purpose:
    this fires once, when the watch's labelled station has already been
    passed/reached, and says so with the real recorded clock time instead
    of a delay prediction that would no longer mean anything. Same
    never-raises contract as send_delay_alert — callers keep going on a
    per-token failure.
    """
    title = f"Train {train_number} update"
    display_name = f"{train_number}" + (f" — {label}" if label else "")
    body = f"{display_name}: {message}"
    if (running or {}).get("headline"):
        body = f"{running['headline']}\n{body}"
    data = {
        "type": "station_reached",
        "train_number": str(train_number),
        "station": station or "",
        "actual_time": actual_time or "",
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=_delay_tag(train_number)),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}


def send_running_status(token: str, train_number: str, running: dict, final: bool = False,
                        alert: bool = False) -> dict:
    """
    FEATURE: background Live Tracking (RailYatri-style ongoing status).
    Sent by alert_scheduler.run_tracking_check_once for every train a
    device was tracking when the app was closed. Uses the SAME per-train
    tag as delay alerts, and is SILENT (no buzz, no re-alert) — it quietly
    updates the one notification card in place as the train moves, the
    way RailYatri's live-status notification does. Only the final
    "Reached <destination>" update is allowed to alert.
    Same never-raises contract as the other send_* functions.
    """
    checked_at = _ist_now()
    name = running.get("train_name")
    dp = running.get("delay_minutes")
    if dp is None:
        late = ""
    elif dp <= 0:
        late = " · On time"
    else:
        late = f" · {dp} min late"
    title = f"{train_number}" + (f" {name}" if name else "") + late
    lines = [running.get("headline") or "Live status updating…"]
    if running.get("detail"):
        lines.append(running["detail"])
    lines.append(f"Updated {checked_at.strftime('%H:%M')}")
    body = "\n".join(lines)
    data = {
        "type": "running_status",
        "train_number": str(train_number),
        "crossed_station": running.get("crossed_station") or "",
        "next_station": running.get("next_station") or "",
        "km_to_next": "" if running.get("km_to_next") is None else str(running["km_to_next"]),
        "next_halt": running.get("next_halt") or "",
        "next_halt_eta": running.get("next_halt_eta") or "",
        "delay_minutes": "" if dp is None else str(dp),
        "completed": "1" if running.get("completed") else "0",
        "checked_at": checked_at.strftime("%H:%M"),
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data, sound="default" if (final or alert) else None)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=_webpush_config(title, body, tag=_train_tag(train_number),
                                renotify=final or alert, silent=not (final or alert)),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}

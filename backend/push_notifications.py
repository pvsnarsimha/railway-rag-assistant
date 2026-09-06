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
from datetime import datetime
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


def _send_via_expo(token: str, title: str, body: str, data: dict) -> dict:
    """Never raises — same never-raises contract as the FCM senders below,
    so alert_scheduler.py can keep going on a per-token failure."""
    try:
        resp = requests.post(
            _EXPO_PUSH_URL,
            json={"to": token, "title": title, "body": body, "data": data, "sound": "default"},
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


def send_delay_alert(
    token: str, train_number: str, label: Optional[str], predicted_delay_minutes: int,
    predicted_for_station: Optional[str] = None,
) -> dict:
    """
    Send one push notification for a breached delay-alert watch.
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
    checked_at = datetime.now()
    title = f"Train {train_number} delayed"
    display_name = f"{train_number}" + (f" — {label}" if label else "")
    station_phrase = f" at {predicted_for_station}" if predicted_for_station else ""
    body = (
        f"{display_name} is now predicted ~{predicted_delay_minutes} min late{station_phrase} "
        f"(as of {checked_at.strftime('%H:%M')})."
    )
    data = {
        "type": "delay_alert",
        "train_number": str(train_number),
        "predicted_delay_minutes": str(predicted_delay_minutes),
        "predicted_for_station": predicted_for_station or "",
        "checked_at": checked_at.strftime("%H:%M"),
    }

    if _is_expo_token(token):
        return _send_via_expo(token, title, body, data)

    if not _ensure_initialized():
        return {"sent": False, "error": _init_error}

    from firebase_admin import messaging

    # Webpush's click-through link must be an absolute HTTPS URL — a bare "/"
    # or an http:// localhost URL are both rejected by FCM outright (this was
    # previously hardcoded to "/" and silently failed every single send).
    # Only attach it once the app is actually deployed behind HTTPS; the
    # service worker's own notificationclick handler still opens the app
    # either way, so this is cosmetic (which URL to jump to), not required.
    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    webpush_kwargs = {"notification": messaging.WebpushNotification(title=title, body=body)}
    if public_url.startswith("https://"):
        webpush_kwargs["fcm_options"] = messaging.WebpushFCMOptions(link=public_url)

    message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=messaging.WebpushConfig(**webpush_kwargs),
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
    checked_at = datetime.now()
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

    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    webpush_kwargs = {"notification": messaging.WebpushNotification(title=title, body=body)}
    if public_url.startswith("https://"):
        webpush_kwargs["fcm_options"] = messaging.WebpushFCMOptions(link=public_url)

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=messaging.WebpushConfig(**webpush_kwargs),
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
    checked_at = datetime.now()
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

    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    webpush_kwargs = {"notification": messaging.WebpushNotification(title=title, body=body)}
    if public_url.startswith("https://"):
        webpush_kwargs["fcm_options"] = messaging.WebpushFCMOptions(link=public_url)

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=messaging.WebpushConfig(**webpush_kwargs),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}


def send_station_status_alert(
    token: str, train_number: str, label: Optional[str], station: Optional[str],
    message: str, actual_time: Optional[str] = None,
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

    public_url = os.environ.get("PUBLIC_APP_URL", "").strip()
    webpush_kwargs = {"notification": messaging.WebpushNotification(title=title, body=body)}
    if public_url.startswith("https://"):
        webpush_kwargs["fcm_options"] = messaging.WebpushFCMOptions(link=public_url)

    fcm_message = messaging.Message(
        token=token,
        notification=messaging.Notification(title=title, body=body),
        data=data,
        webpush=messaging.WebpushConfig(**webpush_kwargs),
    )
    try:
        messaging.send(fcm_message)
        return {"sent": True, "error": None}
    except Exception as e:  # noqa: BLE001
        return {"sent": False, "error": str(e)}

"""
help_content.py
------------------
FEATURE: Smart Help & Tutorial System.

Canned, curated help content for the HELP intent. This is deliberately NOT
routed through the RAG/Claude pipeline - a help/tutorial answer needs to be
100% consistent and predictable (the same "how do I use this" question
should always get the same accurate walkthrough), which a generative
synthesis step can't guarantee. It's also instant and free (no API call),
which matters since this is exactly the kind of question a confused
first-time user asks repeatedly while getting oriented.

The frontend additionally shows a one-time onboarding tour and a persistent
"?" help button (see frontend/app.js) that reuses this same set of example
prompts, so the in-chat answer and the UI tour stay in sync.
"""

EXAMPLE_PROMPTS = [
    {"category": "PNR Status", "example": "What's the status of PNR 2415678901?"},
    {"category": "Live Running Status", "example": "Is train 12951 running late today?"},
    {"category": "Track a Train (GPS)", "example": "Track my train 12951 / GPS location of 12951"},
    {"category": "Route Map", "example": "Show route map for train 12951"},
    {"category": "Seat Availability", "example": "Seat availability on 12951 from NDLS to BCT on 15-08-2026 in 3A"},
    {"category": "Schedule", "example": "Schedule for train 12951"},
    {"category": "Trains Between Stations", "example": "Trains between NDLS and CSMT"},
    {"category": "Nearby Stations", "example": "Stations near NDLS within 200 km"},
    {"category": "Alternative Routes", "example": "Alternative route from NDLS to MAS"},
    {"category": "Crowd Prediction", "example": "How crowded will train 12951 be from NDLS to BCT on 15-08-2026 in SL?"},
    {"category": "Policy / FAQ", "example": "What happens if my Tatkal ticket is still waitlisted?"},
    {"category": "Ticket Photo", "example": "Attach a photo of your ticket instead of typing the PNR"},
    {"category": "Voice", "example": "Tap the mic and just speak your question"},
    {"category": "Multi-Language", "example": "Pick a language from the 🌐 dropdown, or just type in Hindi/Tamil/etc. and I'll reply in kind"},
    {"category": "📡 Live Tracking (WebSocket)", "example": "Tap the 📡 button for a live, auto-updating position feed — and a live delay chart — for the train number you enter"},
    {"category": "🔍 Station Search", "example": "Tap the 🔍 button and search stations by name, code, or a loose description like \"vizag junction\""},
    {"category": "📊 Analytics Dashboard", "example": "Tap the 📊 button to see live charts of query activity, delay predictions, and crowd estimates"},
]


def build_help_answer() -> str:
    lines = [
        "Here's what I can help with — just ask in your own words, no fixed menu needed:\n",
    ]
    for item in EXAMPLE_PROMPTS:
        lines.append(f"• **{item['category']}** — \"{item['example']}\"")
    lines.append(
        "\nA few extra tips:\n"
        "- Tap the 📷 icon to attach a ticket photo instead of typing your PNR.\n"
        "- Tap the 🎙️ mic icon to ask by voice — I'll speak the answer back if voice reply is on.\n"
        "- For live-tracking, route, nearby-station, or alternative-route questions, I'll show an "
        "interactive map alongside the answer.\n"
        "- Use the 🌐 dropdown to pick a reply language, or just type in your language and I'll "
        "detect the script and reply in kind.\n"
        "- Crowd predictions are rule-based estimates from booking data and travel patterns, not a "
        "live headcount sensor — I'll always say so alongside the estimate.\n"
        "- I never invent PNR numbers, train numbers, or statuses — if live data isn't available, "
        "I'll tell you exactly what's missing instead of guessing."
    )
    return "\n".join(lines)

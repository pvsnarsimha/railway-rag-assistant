"""
language_support.py
----------------------
FEATURE: Multi-Language Support (Hindi + Regional Languages).

Two real, honest mechanisms - no translation table of canned phrases
pretending to be a language model:

1. SCRIPT DETECTION: a lightweight, genuine Unicode-block check on the
   user's own typed text. If someone types their question in Devanagari,
   Tamil, Telugu, Bengali, Kannada, Malayalam, or Gurmukhi script, we detect
   that from the actual characters they typed (not a guess) and tell Claude
   which language the reply should be in.
2. EXPLICIT SELECTION: the frontend language dropdown sends a
   `language` field with the request; if the user chose something other
   than "auto", that always wins over detection.

Either way, the actual translation is done by Claude itself at answer-
synthesis time (Claude already writes the final answer in app.py) - this
module never invents or hardcodes a translation, it only decides *which*
language to ask Claude to answer in, and only for languages Claude can
actually read/write.

If no ANTHROPIC_API_KEY is configured, the templated fallback answer stays
in English (there is no local translation step to fall back on) - and this
module's `fallback_note()` says so plainly instead of silently ignoring the
requested language.
"""

from dataclasses import dataclass
from typing import Optional

# Unicode block ranges for genuine script detection - not a guess, a real
# codepoint check against text the user actually typed.
_SCRIPT_RANGES = {
    "Hindi": [(0x0900, 0x097F)],          # Devanagari
    "Bengali": [(0x0980, 0x09FF)],
    "Punjabi": [(0x0A00, 0x0A7F)],         # Gurmukhi
    "Gujarati": [(0x0A80, 0x0AFF)],
    "Tamil": [(0x0B80, 0x0BFF)],
    "Telugu": [(0x0C00, 0x0C7F)],
    "Kannada": [(0x0C80, 0x0CFF)],
    "Malayalam": [(0x0D00, 0x0D7F)],
    "Marathi": [(0x0900, 0x097F)],         # Marathi also uses Devanagari; disambiguated by explicit selection only
    "Odia": [(0x0B00, 0x0B7F)],
}

SUPPORTED_LANGUAGES = [
    "English", "Hindi", "Bengali", "Tamil", "Telugu", "Kannada",
    "Malayalam", "Marathi", "Gujarati", "Punjabi", "Odia",
]


def detect_script_language(text: str) -> Optional[str]:
    """Returns the first supported language whose Unicode block appears in
    `text`, or None if the text looks like plain Latin script (i.e. English
    or romanized text) - which is left as None rather than guessed, since a
    Latin-script message could be English OR romanized Hindi/etc. and we'd
    rather fall through to the default than mislabel it."""
    if not text:
        return None
    for ch in text:
        cp = ord(ch)
        for lang, ranges in _SCRIPT_RANGES.items():
            if lang == "Marathi":
                continue  # same range as Hindi; only reachable via explicit selection
            for lo, hi in ranges:
                if lo <= cp <= hi:
                    return lang
    return None


@dataclass
class LanguageChoice:
    language: str            # resolved language name to instruct Claude with, e.g. "Hindi"
    source: str              # "explicit_selection" | "script_detection" | "default"


def resolve_language(explicit_language: Optional[str], message_text: str) -> LanguageChoice:
    """Explicit dropdown selection always wins; otherwise fall back to
    script detection on the actual typed text; otherwise default to
    English."""
    if explicit_language and explicit_language.strip().lower() not in ("", "auto", "english"):
        return LanguageChoice(language=explicit_language.strip(), source="explicit_selection")

    detected = detect_script_language(message_text)
    if detected:
        return LanguageChoice(language=detected, source="script_detection")

    return LanguageChoice(language="English", source="default")


def synthesis_instruction(choice: LanguageChoice) -> str:
    """Appended to the Claude system prompt in app.py so the final answer is
    actually written in the resolved language - translation happens inside
    the one real Claude call this app already makes, not via a second
    hardcoded lookup."""
    if choice.language == "English":
        return ""
    return (
        f"\n\nRespond in {choice.language} (using its native script), regardless of what script the "
        "context excerpts above are written in. Still never invent facts, PNRs, train numbers, or "
        "statuses - translate/express only what's actually grounded in the context."
    )


def fallback_note(choice: LanguageChoice) -> Optional[str]:
    """For the no-ANTHROPIC_API_KEY templated fallback path, which can't
    translate anything - tells the user plainly instead of silently
    ignoring their language choice."""
    if choice.language == "English":
        return None
    return (
        f"(A reply in {choice.language} needs ANTHROPIC_API_KEY configured for live translation - "
        "showing the raw English fallback below instead.)"
    )

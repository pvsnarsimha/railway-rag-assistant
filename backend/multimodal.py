"""
multimodal.py
----------------
FEATURE 5: Multi-Modal RAG.

Two directions of "multi-modal" are handled here, both grounded in what's
actually useful for a railway passenger assistant (not fabricated demo
imagery):

1. IMAGE -> TEXT (query side): a passenger can attach a photo of a printed
   ticket / SMS screenshot instead of typing their PNR or train number.
   `extract_entities_from_image()` sends the image to Claude's vision input
   and asks it to pull out ONLY the literal digits/text visible in the
   photo (PNR, train number, date) - never to guess or invent a number it
   can't actually read, to keep the "never fabricate railway data" rule from
   the README intact for the image path too.

2. TEXT -> IMAGE (answer side): certain knowledge-base entries (coach
   classes, quota types) are much clearer as a diagram than a paragraph.
   `get_diagrams_for_entities()` looks up small locally-hosted SVG diagrams
   (frontend/assets/diagrams/) tagged onto KB entries via a `diagram` field,
   and returns them so the API response can tell the frontend which image(s)
   to render alongside the text answer.
"""

import base64
import json
import os
from dataclasses import dataclass
from typing import List, Optional


DIAGRAM_BASE_URL = "/assets/diagrams"


@dataclass
class ImageExtractionResult:
    pnr: Optional[str]
    train_number: Optional[str]
    date_ddmmyyyy: Optional[str]
    raw_note: str
    error: Optional[str] = None


def extract_entities_from_image(image_b64: str, media_type: str, anthropic_api_key: str) -> ImageExtractionResult:
    """
    Uses Claude's vision input to read a ticket/PNR photo. Requires
    ANTHROPIC_API_KEY - there is no OCR fallback here on purpose, since a
    naive local OCR pass on a phone photo of a ticket is exactly the kind of
    thing that quietly returns a wrong digit and should not be trusted for
    a real PNR lookup without the same care Claude is asked to take below.
    """
    if not anthropic_api_key:
        return ImageExtractionResult(
            None, None, None, "",
            error="Reading ticket photos requires ANTHROPIC_API_KEY to be configured.",
        )

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=anthropic_api_key)

        system = (
            "You read Indian Railways ticket/PNR photos or SMS screenshots. "
            "Extract ONLY digits/text that are literally visible in the image. "
            "Never guess, complete, or invent a PNR or train number you cannot "
            "clearly read. Respond with ONLY a JSON object, no markdown fences, "
            'in the form: {"pnr": "<10 digits or null>", "train_number": '
            '"<4-5 digits or null>", "date_ddmmyyyy": "<DD-MM-YYYY or null>", '
            '"note": "<one short sentence on what you saw / could not read>"}'
        )
        response = client.messages.create(
            model=os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-5"),
            max_tokens=300,
            system=system,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                    {"type": "text", "text": "Extract the railway ticket details from this image."},
                ],
            }],
        )
        text = "".join(b.text for b in response.content if b.type == "text").strip()
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
        parsed = json.loads(text)

        return ImageExtractionResult(
            pnr=parsed.get("pnr") or None,
            train_number=parsed.get("train_number") or None,
            date_ddmmyyyy=parsed.get("date_ddmmyyyy") or None,
            raw_note=parsed.get("note", ""),
        )
    except Exception as exc:
        return ImageExtractionResult(
            None, None, None, "",
            error=f"Could not read the image ({type(exc).__name__}): {exc}",
        )


def get_diagrams_for_docs(docs: List[dict]) -> List[dict]:
    """
    docs: KB entry dicts (or dicts with a 'diagram' key) already selected by
    retrieval. Returns [{"id", "label", "url"}] for any that carry a
    `diagram` filename, so the frontend can render the SVG inline next to
    the text answer that references it.
    """
    diagrams = []
    for doc in docs:
        filename = doc.get("diagram")
        if filename:
            diagrams.append({
                "id": doc["id"],
                "label": doc.get("category", doc["id"]),
                "url": f"{DIAGRAM_BASE_URL}/{filename}",
            })
    return diagrams

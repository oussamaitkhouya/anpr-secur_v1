"""Server-side plate masking. Search results carry masked plates; the full plate only leaves the
server through POST /plates/{id}/reveal (justified, permission-checked, audited).

    12345|ب|6  ->  ***45|ب|6      (all but the last 2 digits of the number are hidden)
    7|ب|6      ->  *|ب|6
    raw text that is not a valid plate: all but the last 2 characters hidden
"""

MASK_CHAR = "*"
VISIBLE = 2


def mask_plate(canonical: str | None, raw: str = "") -> str:
    if canonical:
        number, letter, region = canonical.split("|")
        hidden = len(number) if len(number) <= VISIBLE else len(number) - VISIBLE
        return f"{MASK_CHAR * hidden}{number[hidden:]}|{letter}|{region}"
    text = raw.strip()
    if len(text) <= VISIBLE:
        return MASK_CHAR * len(text)
    return MASK_CHAR * (len(text) - VISIBLE) + text[-VISIBLE:]


FIXED_MASK = "••••"


def mask_fixed(canonical: str) -> str:
    """The dashboard's rule (dashboard/src/lib/mask.ts): the number becomes a fixed-width mask, so
    its length is hidden too, and only its last digit stays when it has 3 or more digits.

        12345|ب|6 -> ••••5|ب|6      42|د|1 -> ••••|د|1
    """
    parts = canonical.split("|")
    if len(parts) != 3:
        return f"{FIXED_MASK}|?|?"  # never echo text that failed to parse
    number, letter, region = parts
    return f"{FIXED_MASK}{number[-1] if len(number) >= 3 else ''}|{letter}|{region}"

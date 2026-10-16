import re
from dataclasses import dataclass

from anpr.utils.config import PlateFormat, default_plate_format

_ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_PATTERN = re.compile(r"^(\d{1,5})\|(.)\|(\d{1,2})$")


@dataclass(frozen=True)
class Plate:
    number: int
    letter: str
    region: int

    def canonical(self) -> str:
        return f"{self.number}|{self.letter}|{self.region}"


def normalize(text: str) -> str:
    text = text.translate(_ARABIC_DIGITS)
    text = text.replace("ـ", "")          # tatweel (so "هـ" becomes "ه")
    text = re.sub(r"[\s\-_/.,:;]+", "|", text.strip())
    return text


def parse_plate(text: str, fmt: PlateFormat | None = None) -> Plate | None:
    """Return a Plate if text matches the Moroccan format, else None.

    Letters and region range come from configs/plate_format.yaml unless fmt is given.
    """
    fmt = fmt or default_plate_format()
    m = _PATTERN.match(normalize(text))
    if not m:
        return None
    number, letter, region = int(m[1]), m[2], int(m[3])
    if letter not in fmt.letters:
        return None
    if number == 0 or not (fmt.region_min <= region <= fmt.region_max):
        return None
    return Plate(number, letter, region)

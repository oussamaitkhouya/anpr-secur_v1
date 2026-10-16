"""Parse CCPD (Chinese City Parking Dataset) annotations, which live in the image filename.

Used only to pre-train the plate detector: we need the bounding box, not the Chinese
plate text. Example name (7 fields separated by "-"):

    025-95_113-154&383_386&473-386&473_177&454_154&383_363&402-0_0_22_27_27_33_16-37-15.jpg
    area | tilt  | bbox x1&y1_x2&y2 | 4 vertices (from bottom-right) | char indices | brightness | blur

Files that do not follow this format (e.g. ccpd_np, which has no plate) are skipped
and counted, not treated as errors.
"""

from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

N_FIELDS = 7
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}

Point = tuple[int, int]


@dataclass(frozen=True)
class CCPDAnnotation:
    area: str                                   # kept as text: the README does not define its scale
    tilt: tuple[int, int]                       # horizontal, vertical tilt degrees
    bbox: tuple[int, int, int, int]             # x1, y1, x2, y2 in pixels (top-left, bottom-right)
    vertices: tuple[Point, Point, Point, Point]  # exact corners, starting from the bottom-right
    chars: tuple[int, ...]                      # indices into the CCPD character tables (unused here)
    brightness: int
    blur: int


@dataclass(frozen=True)
class CCPDSample:
    path: Path
    annotation: CCPDAnnotation


@dataclass
class ScanResult:
    samples: list[CCPDSample] = field(default_factory=list)
    skipped: Counter = field(default_factory=Counter)  # reason -> count
    skipped_examples: dict[str, str] = field(default_factory=dict)  # reason -> one filename


def _point(text: str) -> Point:
    x, y = text.split("&")
    return int(x), int(y)


def parse_filename(name: str) -> CCPDAnnotation:
    """Parse one CCPD filename (with or without directory/extension). Raises ValueError if malformed."""
    stem = Path(name).stem
    parts = stem.split("-")
    if len(parts) != N_FIELDS:
        raise ValueError(f"expected {N_FIELDS} '-'-separated fields, got {len(parts)}")
    area, tilt, bbox, vertices, chars, brightness, blur = parts
    try:
        h_tilt, v_tilt = (int(v) for v in tilt.split("_"))
        top_left, bottom_right = (_point(p) for p in bbox.split("_"))
        corners = tuple(_point(p) for p in vertices.split("_"))
        char_ids = tuple(int(c) for c in chars.split("_"))
        ann = CCPDAnnotation(area, (h_tilt, v_tilt), (*top_left, *bottom_right), corners,
                             char_ids, int(brightness), int(blur))
    except ValueError as e:  # wrong number of items to unpack, or non-integer text
        raise ValueError(f"bad field value: {e}") from None
    if len(ann.vertices) != 4:
        raise ValueError(f"expected 4 vertices, got {len(ann.vertices)}")
    x1, y1, x2, y2 = ann.bbox
    if min(ann.bbox) < 0 or x1 >= x2 or y1 >= y2:
        raise ValueError(f"invalid bounding box {ann.bbox}")
    return ann


def image_size(path: Path) -> tuple[int, int]:
    """(width, height), read from the file header without decoding the pixels."""
    with Image.open(path) as img:
        return img.size


def scan(paths: Iterable[Path]) -> ScanResult:
    """Parse every image path; malformed names are skipped and counted by reason."""
    result = ScanResult()
    for path in paths:
        if path.suffix.lower() not in IMAGE_SUFFIXES:
            reason = "not an image"
        else:
            try:
                result.samples.append(CCPDSample(path, parse_filename(path.name)))
                continue
            except ValueError:
                reason = "malformed filename"
        result.skipped[reason] += 1
        result.skipped_examples.setdefault(reason, path.name)
    return result


def list_subset(root: Path, subset: str) -> list[Path]:
    """All files directly inside root/subset, sorted so results do not depend on the filesystem."""
    folder = root / subset
    if not folder.is_dir():
        raise FileNotFoundError(f"CCPD subset folder not found: {folder}")
    return sorted(p for p in folder.iterdir() if p.is_file())

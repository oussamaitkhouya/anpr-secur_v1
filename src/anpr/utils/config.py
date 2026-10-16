from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
CONFIG_DIR = REPO_ROOT / "configs"
PLATE_FORMAT_PATH = CONFIG_DIR / "plate_format.yaml"


@dataclass(frozen=True)
class PlateType:
    name: str
    description: str
    pattern: str
    verified: bool
    background: str = "white"
    text_color: str = "black"


@dataclass(frozen=True)
class PlateFormat:
    letters: frozenset[str]
    region_min: int
    region_max: int
    plate_types: dict[str, PlateType]


def load_plate_format(path: Path | str = PLATE_FORMAT_PATH) -> PlateFormat:
    """Read and check the plate format YAML. Raises ValueError if it is malformed."""
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    try:
        letters = frozenset(str(c) for c in raw["letters"]["values"])
        region_min = int(raw["region"]["min"])
        region_max = int(raw["region"]["max"])
        plate_types = {
            name: PlateType(
                name=name,
                description=str(t.get("description", "")),
                pattern=str(t.get("pattern", "")),
                verified=bool(t.get("verified", False)),
                background=str((t.get("style") or {}).get("background", "white")),
                text_color=str((t.get("style") or {}).get("text", "black")),
            )
            for name, t in raw["plate_types"].items()
        }
    except (KeyError, TypeError, ValueError) as e:
        raise ValueError(f"invalid plate format config {path}: {e!r}") from e

    if not letters or any(len(c) != 1 for c in letters):
        raise ValueError(f"{path}: letters must be a non-empty list of single characters")
    if not 1 <= region_min <= region_max:
        raise ValueError(f"{path}: need 1 <= region.min <= region.max")

    return PlateFormat(letters, region_min, region_max, plate_types)


@lru_cache(maxsize=1)
def default_plate_format() -> PlateFormat:
    """The plate format from configs/plate_format.yaml, loaded once."""
    return load_plate_format()

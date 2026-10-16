"""Plates in one camera frame: YOLO finds the plate boxes, the CRNN reads each box.

    ANPR_DETECTOR_WEIGHTS  YOLO weights (default runs/detector/full/weights/last.pt)
    ANPR_OCR_WEIGHTS       CRNN checkpoint from anpr.training.train_ocr. Unset: boxes only, no
                           plate text, so nothing can be matched against a watchlist.

Models load on first use, not at import, so the API starts without torch work. One lock around
inference: Ultralytics and the LSTM are not safe to call from two threads at once.
"""

import logging
import os
import threading
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from anpr.pipeline.matcher import canonical_or_none
from anpr.utils.config import REPO_ROOT, default_plate_format

log = logging.getLogger("anpr.pipeline.live")
DEFAULT_DETECTOR = REPO_ROOT / "runs" / "detector" / "full" / "weights" / "last.pt"
MIN_BOX_CONFIDENCE = 0.25
MAX_SIDE = 4096  # refuse absurd frames before they reach the model


class FrameError(ValueError):
    """The upload is not a usable image. Message is safe to show."""


@dataclass(frozen=True)
class Found:
    box: tuple[float, float, float, float]  # x, y, w, h as fractions of the frame
    box_confidence: float
    plate: str | None = None               # canonical, or None (no OCR, or not a valid plate)
    confidence: float = 0.0                # plate confidence: the weakest character
    chars: tuple[tuple[str, float], ...] = field(default_factory=tuple)  # separators excluded


def decode_jpeg(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise FrameError("The frame is not a readable image.")
    h, w = img.shape[:2]
    if h > MAX_SIDE or w > MAX_SIDE:
        raise FrameError(f"Frames must be at most {MAX_SIDE} pixels per side.")
    return img


class FrameDetector:
    def __init__(self, detector_path: Path | str | None = None, ocr_path: Path | str | None = None):
        self.detector_path = Path(detector_path or os.environ.get("ANPR_DETECTOR_WEIGHTS") or DEFAULT_DETECTOR)
        ocr = ocr_path or os.environ.get("ANPR_OCR_WEIGHTS")
        self.ocr_path = Path(ocr) if ocr else None
        self._lock = threading.Lock()
        self._yolo = None
        self._ocr = None  # (model, charset, (height, width), metrics)

    @property
    def reads_plates(self) -> bool:
        return self.ocr_path is not None

    @property
    def version(self) -> str:
        parts = [f"yolo:{self.detector_path.parent.parent.name}/{self.detector_path.name}"]
        if self.ocr_path:
            parts.append(f"crnn:{self.ocr_path.parent.name}/{self.ocr_path.name}")
        return " + ".join(parts)

    def ocr_metrics(self) -> dict | None:
        """Validation metrics stored in the OCR checkpoint by train_ocr (plate_acc, char_acc...)."""
        if not self.ocr_path:
            return None
        with self._lock:
            self._load()
        return self._ocr[3]

    def read_plate(self, crop_bgr: np.ndarray) -> tuple[str | None, float, tuple[tuple[str, float], ...]]:
        """OCR on an already-cropped plate (evaluation, tests). Loads only the CRNN, not YOLO."""
        if not self.ocr_path:
            raise FileNotFoundError("ANPR_OCR_WEIGHTS is not set")
        with self._lock:
            self._load(detector=False)
            return self._read(crop_bgr)

    def _load(self, detector: bool = True) -> None:
        if detector and self._yolo is None:
            if not self.detector_path.is_file():
                raise FileNotFoundError(f"detector weights not found: {self.detector_path}")
            from ultralytics import YOLO
            self._yolo = YOLO(str(self.detector_path))
        if self.ocr_path and self._ocr is None:
            import torch

            from anpr.models.ocr_crnn import CRNN
            from anpr.models.ocr_labels import DIGITS, SEPARATOR, Charset

            ckpt = torch.load(self.ocr_path, map_location="cpu")
            chars = list(ckpt["charset"])
            charset = Charset(chars[len(DIGITS) + len(SEPARATOR):])
            if charset.chars != chars:
                raise ValueError(f"{self.ocr_path}: charset does not match the CRNN label layout")
            height, width = ckpt.get("img_size", (32, 160))
            model = CRNN(charset.num_classes, img_height=height)
            model.load_state_dict(ckpt["model"])
            model.eval()
            self._ocr = (model, charset, (height, width), ckpt.get("metrics") or {})

    def detect(self, frame_bgr: np.ndarray) -> list[Found]:
        with self._lock:
            self._load()
            result = self._yolo.predict(frame_bgr, conf=MIN_BOX_CONFIDENCE, verbose=False)[0]
            h, w = frame_bgr.shape[:2]
            found = []
            for xyxy, conf in zip(result.boxes.xyxy.tolist(), result.boxes.conf.tolist(), strict=True):
                x1, y1, x2, y2 = (max(0, int(v)) for v in xyxy)
                box = (x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h)
                plate, confidence, chars = self._read(frame_bgr[y1:y2, x1:x2]) if self._ocr else (None, 0.0, ())
                found.append(Found(box, round(float(conf), 4), plate, confidence, chars))
            return found

    def _read(self, crop_bgr: np.ndarray) -> tuple[str | None, float, tuple[tuple[str, float], ...]]:
        """Most probable VALID plate (anpr.models.plate_decoder), with a confidence per character.

        When no valid plate fits the image, falls back to the CTC best path so the raw text can
        still be shown for debugging; it fails canonical validation, so it is never matched."""
        import torch

        from anpr.models.ocr_crnn import preprocess
        from anpr.models.ocr_labels import BLANK, SEPARATOR
        from anpr.models.plate_decoder import PlateGrammar, decode_plate

        if crop_bgr.size == 0:
            return None, 0.0, ()
        model, charset, (height, width), _ = self._ocr
        image = Image.fromarray(cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2RGB))
        with torch.no_grad():
            log_probs = model(preprocess(image, height, width).unsqueeze(0))[:, 0, :]  # (T, C)
        decoded = decode_plate(log_probs.numpy(), charset, PlateGrammar.from_format(default_plate_format()))
        if decoded is not None:
            plate, confs, _ = decoded
            chars = tuple((c, round(p, 4)) for c, p in zip(plate, confs, strict=True) if c != SEPARATOR)
            log.debug("OCR constrained=%r chars=%r", plate, chars)
            return plate, min(p for _, p in chars), chars

        probs = log_probs.exp()
        best_p, best_id = probs.max(dim=1)
        text, confs, prev = [], [], BLANK
        for i, p in zip(best_id.tolist(), best_p.tolist(), strict=True):
            if i != BLANK and i == prev:
                confs[-1] = max(confs[-1], p)
            elif i != BLANK:
                text.append(charset.chars[i - 1])
                confs.append(p)
            prev = i
        chars = tuple((c, round(p, 4)) for c, p in zip(text, confs, strict=True) if c != SEPARATOR)
        raw_text = "".join(text)
        plate = canonical_or_none(raw_text)
        # debug log, not print: printing Arabic to a cp1252 Windows console raises UnicodeEncodeError
        log.debug("OCR raw=%r canonical=%r chars=%r", raw_text, plate, chars)
        if not chars:
            return "EMPTY_OCR", 0.0, ()
        
        # If it fails strict validation, return the raw text so we can debug it on screen!
        return plate or raw_text, min(p for _, p in chars), chars

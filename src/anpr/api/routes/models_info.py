"""Model performance: what the models scored in training, and how live reads look.

Training figures come from the artifacts themselves (Ultralytics results.csv for the detector,
the metrics dict stored in the CRNN checkpoint). They are validation scores on the training
data's own split, not field accuracy, and the response says so. A checkpoint whose path marks it
as an overfit sanity check is flagged: its 100% means it memorised a tiny set.

Live figures are computed from real detections in the caller's cities: share of valid plates,
plate confidence, and what reviewers decided about alerts (the closest thing to field precision
without ground truth). Paths are shown relative to the repo, never absolute.
"""

import csv
import os
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import case, func, select

from anpr.api.deps import Db, rate_limit, require
from anpr.db import scoping
from anpr.db.models import Alert, DetectionEvent
from anpr.pipeline.live import DEFAULT_DETECTOR
from anpr.security.rbac import Actor
from anpr.utils.config import REPO_ROOT

router = APIRouter(tags=["models"], dependencies=[Depends(rate_limit("models", "camera_rate_per_minute"))])
ModelsRead = Annotated[Actor, Depends(require("models.read"))]


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT)).replace("\\", "/")
    except ValueError:
        return path.name


def _float(v: str | None) -> float | None:
    try:
        return round(float(v), 4) if v not in (None, "") else None
    except ValueError:
        return None


@lru_cache(maxsize=4)
def _detector_info(weights: str, mtime: float) -> dict:
    path = Path(weights)
    run = path.parent.parent
    info: dict = {"weights": _rel(path), "available": path.is_file(), "run": run.name, "epochs": [], "final": None,
                  "plannedEpochs": None, "baseModel": None, "imageSize": None}
    results = run / "results.csv"
    if results.is_file():
        with open(results, encoding="utf-8") as f:
            rows = [{k.strip(): v for k, v in r.items()} for r in csv.DictReader(f)]
        info["epochs"] = [{"epoch": int(float(r["epoch"])), "precision": _float(r.get("metrics/precision(B)")),
                           "recall": _float(r.get("metrics/recall(B)")), "map50": _float(r.get("metrics/mAP50(B)")),
                           "map5095": _float(r.get("metrics/mAP50-95(B)"))} for r in rows]
        info["final"] = info["epochs"][-1] if info["epochs"] else None
    args = run / "args.yaml"
    if args.is_file():
        import yaml
        cfg = yaml.safe_load(args.read_text(encoding="utf-8")) or {}
        info["plannedEpochs"] = cfg.get("epochs")
        info["baseModel"] = Path(str(cfg.get("model", ""))).name or None
        info["imageSize"] = cfg.get("imgsz")
    return info


@lru_cache(maxsize=4)
def _ocr_info(weights: str, mtime: float) -> dict:
    path = Path(weights)
    info: dict = {"weights": _rel(path), "available": path.is_file(), "metrics": None, "epoch": None,
                  "sanityCheckOnly": "overfit" in str(path).lower()}
    if path.is_file():
        import torch
        # our own checkpoint file (written by anpr.training.train_ocr), never an upload
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        m = ckpt.get("metrics") or {}
        info["metrics"] = {k: m.get(k) for k in ("plate_acc", "char_acc", "val_loss", "train_loss") if k in m}
        info["epoch"] = ckpt.get("epoch")
    return info


def _mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


@router.get("/models", summary="Training metrics of the deployed models and live read quality")
def models(actor: ModelsRead, db: Db):
    det_path = Path(os.environ.get("ANPR_DETECTOR_WEIGHTS") or DEFAULT_DETECTOR)
    ocr_env = os.environ.get("ANPR_OCR_WEIGHTS")
    ocr_path = Path(ocr_env) if ocr_env else None
    if ocr_path and not ocr_path.is_absolute():
        ocr_path = REPO_ROOT / ocr_path
    if not det_path.is_absolute():
        det_path = REPO_ROOT / det_path

    now = datetime.now(UTC)
    live = {}
    for label, since in (("last24h", now - timedelta(hours=24)), ("last7d", now - timedelta(days=7))):
        base = scoping.detections(select(
            func.count(), func.sum(case((DetectionEvent.plate_canonical.is_not(None), 1), else_=0)),
            func.avg(DetectionEvent.plate_confidence),
            func.sum(case((DetectionEvent.plate_confidence < 0.85, 1), else_=0)),
        ).select_from(DetectionEvent), actor).where(DetectionEvent.observed_at >= since)
        total, valid, conf, low = db.execute(base).one()
        decisions = dict(db.execute(scoping.alerts(select(Alert.status, func.count()).select_from(Alert), actor)
                                    .where(Alert.created_at >= since).group_by(Alert.status)).all())
        decided = decisions.get("approved", 0) + decisions.get("rejected", 0)
        live[label] = {
            "reads": total or 0, "validPlates": valid or 0,
            "validShare": round((valid or 0) / total, 4) if total else None,
            "meanConfidence": round(float(conf), 4) if conf is not None else None,
            "lowConfidenceReads": low or 0,
            "alerts": decisions, "confirmedShare": round(decisions.get("approved", 0) / decided, 4) if decided else None,
        }
    return {
        "detector": _detector_info(str(det_path), _mtime(det_path)),
        "ocr": _ocr_info(str(ocr_path), _mtime(ocr_path)) if ocr_path else None,
        "live": live,
        "note": "Training scores are validation results on the training data's own split, not field accuracy. "
                "Field quality is estimated from live reads and from what reviewers confirmed.",
    }

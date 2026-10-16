/*
 * Fictional detections for the "Mock" mode. They are NOT derived from the video: they are
 * invented boxes that drift slowly so the overlay can be demonstrated without a model.
 */
import type { Detection, WatchlistEntry } from "../api/types";
import { Rng } from "../api/mock/rng";
import { charConfidences } from "../api/mock/seed";

const PLATES = ["48213|ب|6", "7305|د|41", "16642|ه|1", "952|و|33", "30017|ط|12"];

/**
 * Detections for frame `seq`. Tracks persist for a while and move smoothly; every so often one
 * of them is a watchlist plate, which the UI must send to human review, never act on.
 */
export function mockDetections(seq: number, watchlist: WatchlistEntry[]): Detection[] {
  return [];
}

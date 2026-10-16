import { FileVideo, Radio, Webcam, type LucideIcon } from "lucide-react";
import type { SourceType } from "../../api/types";

export const SOURCE_LABELS: Record<SourceType, string> = { "browser-webcam": "Browser webcam", rtsp: "RTSPS stream", file: "Recorded file" };
export const SOURCE_ICONS: Record<SourceType, LucideIcon> = { "browser-webcam": Webcam, rtsp: Radio, file: FileVideo };

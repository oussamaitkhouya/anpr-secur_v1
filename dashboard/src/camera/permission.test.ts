import { describe, expect, it, vi } from "vitest";
import {
  cameraReducer, classifyMediaError, INITIAL_CAMERA_STATE, listCameras, requestCamera, stopStream,
  type CameraEvent, type CameraState, type MediaDevicesLike,
} from "./permission";
import { captureIntervalMs, scaledSize } from "./frameCapture";

// ---- fakes ---------------------------------------------------------------------------

function fakeTrack(label = "Test Cam", deviceId = "dev-1") {
  return { kind: "video", label, stop: vi.fn(), getSettings: () => ({ deviceId, width: 1280, height: 720 }) };
}

function fakeStream(tracks = [fakeTrack()]) {
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === "video") } as unknown as MediaStream;
}

function domError(name: string, message = "") {
  const e = new Error(message);
  e.name = name;
  return e;
}

function fakeDevices(getUserMedia: MediaDevicesLike["getUserMedia"], devices: Partial<MediaDeviceInfo>[] = []): MediaDevicesLike {
  return { getUserMedia, enumerateDevices: async () => devices as MediaDeviceInfo[] };
}

const run = (events: CameraEvent[], from: CameraState = INITIAL_CAMERA_STATE) => events.reduce(cameraReducer, from);

// ---- state machine -------------------------------------------------------------------

describe("cameraReducer", () => {
  it("goes idle -> requesting -> live -> idle", () => {
    expect(run([{ type: "START" }]).status).toBe("requesting");
    const live = run([{ type: "START" }, { type: "GRANTED", deviceId: "d", label: "Cam" }]);
    expect(live).toEqual({ status: "live", deviceId: "d", label: "Cam" });
    expect(cameraReducer(live, { type: "STOP" }).status).toBe("idle");
  });

  it("reaches denied, no_camera and error from requesting, each with a message", () => {
    expect(run([{ type: "START" }, { type: "DENIED", message: "m" }])).toEqual({ status: "denied", message: "m" });
    expect(run([{ type: "START" }, { type: "NO_CAMERA", message: "m" }]).status).toBe("no_camera");
    expect(run([{ type: "START" }, { type: "FAILED", message: "m" }]).status).toBe("error");
  });

  it("can retry from every failure state", () => {
    for (const status of ["denied", "no_camera", "error"] as const) {
      expect(cameraReducer({ status, message: "x" }, { type: "START" }).status).toBe("requesting");
    }
  });

  it("ignores events that do not fit the current state", () => {
    expect(run([{ type: "GRANTED", deviceId: null, label: "" }]).status).toBe("idle"); // grant without a request
    const live: CameraState = { status: "live", deviceId: null, label: "" };
    expect(cameraReducer(live, { type: "START" })).toBe(live); // double start
    expect(cameraReducer(live, { type: "DENIED", message: "late" })).toBe(live); // stale rejection
  });

  it("moves a live stream to error when the device goes away", () => {
    const live: CameraState = { status: "live", deviceId: null, label: "" };
    expect(cameraReducer(live, { type: "ENDED", message: "unplugged" })).toEqual({ status: "error", message: "unplugged" });
  });
});

describe("classifyMediaError", () => {
  it.each([
    ["NotAllowedError", "DENIED"],
    ["SecurityError", "DENIED"],
    ["NotFoundError", "NO_CAMERA"],
    ["OverconstrainedError", "NO_CAMERA"],
    ["NotReadableError", "FAILED"],
    ["SomethingElse", "FAILED"],
  ])("%s -> %s", (name, type) => {
    expect(classifyMediaError(domError(name)).type).toBe(type);
  });
});

// ---- requestCamera with a mocked getUserMedia ----------------------------------------

describe("requestCamera", () => {
  it("asks for video only, never audio, and reports the granted device", async () => {
    const getUserMedia = vi.fn(async () => fakeStream());
    const { event, stream } = await requestCamera(fakeDevices(getUserMedia), { deviceId: "dev-1" });
    expect(getUserMedia).toHaveBeenCalledOnce();
    const constraints = getUserMedia.mock.calls[0] as unknown as [MediaStreamConstraints];
    expect(constraints[0].audio).toBe(false);
    expect((constraints[0].video as MediaTrackConstraints).deviceId).toEqual({ exact: "dev-1" });
    expect(event).toEqual({ type: "GRANTED", deviceId: "dev-1", label: "Test Cam" });
    expect(stream).not.toBeNull();
  });

  it("maps a refused permission to denied", async () => {
    const { event, stream } = await requestCamera(fakeDevices(async () => { throw domError("NotAllowedError"); }));
    expect(event.type).toBe("DENIED");
    expect(stream).toBeNull();
  });

  it("maps a missing device to no_camera", async () => {
    const { event } = await requestCamera(fakeDevices(async () => { throw domError("NotFoundError"); }));
    expect(event.type).toBe("NO_CAMERA");
  });

  it("reports an error when the browser has no camera API (e.g. plain HTTP)", async () => {
    const { event } = await requestCamera(undefined);
    expect(event.type).toBe("FAILED");
  });

  it("treats a stream without a video track as no camera, and stops it", async () => {
    const audioOnly = { kind: "audio", label: "", stop: vi.fn(), getSettings: () => ({}) };
    const { event } = await requestCamera(fakeDevices(async () => fakeStream([audioOnly as never])));
    expect(event.type).toBe("NO_CAMERA");
    expect(audioOnly.stop).toHaveBeenCalled();
  });

  it("drives the state machine end to end", async () => {
    let state = cameraReducer(INITIAL_CAMERA_STATE, { type: "START" });
    const { event } = await requestCamera(fakeDevices(async () => { throw domError("NotAllowedError"); }));
    state = cameraReducer(state, event);
    expect(state.status).toBe("denied");
    state = cameraReducer(state, { type: "START" });
    state = cameraReducer(state, (await requestCamera(fakeDevices(async () => fakeStream()))).event);
    expect(state.status).toBe("live");
  });
});

describe("stopStream and listCameras", () => {
  it("stops every track and tolerates null", () => {
    const tracks = [fakeTrack(), fakeTrack("Second")];
    stopStream(fakeStream(tracks));
    expect(tracks.every((t) => t.stop.mock.calls.length === 1)).toBe(true);
    expect(() => stopStream(null)).not.toThrow();
  });

  it("lists only video inputs and labels unnamed ones", async () => {
    const list = await listCameras(fakeDevices(vi.fn(), [
      { kind: "videoinput", deviceId: "a", label: "" },
      { kind: "audioinput", deviceId: "b", label: "Mic" },
      { kind: "videoinput", deviceId: "c", label: "USB Cam" },
    ]));
    expect(list).toEqual([{ deviceId: "a", label: "Camera 1" }, { deviceId: "c", label: "USB Cam" }]);
  });
});

describe("frame capture helpers", () => {
  it("defaults to 2 fps and clamps silly rates", () => {
    expect(captureIntervalMs(2)).toBe(500);
    expect(captureIntervalMs(1000)).toBe(100);
    expect(captureIntervalMs(0)).toBe(5000);
    expect(captureIntervalMs(Number.NaN)).toBe(500);
  });

  it("scales frames down keeping the aspect ratio", () => {
    expect(scaledSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(scaledSize(640, 480, 1280)).toEqual({ width: 640, height: 480 });
    expect(scaledSize(0, 0, 1280)).toEqual({ width: 0, height: 0 });
  });
});

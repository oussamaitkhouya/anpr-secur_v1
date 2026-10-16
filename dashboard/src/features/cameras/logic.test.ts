import { describe, expect, it } from "vitest";
import {
  assembledUrlPreview, cityHealth, emptyForm, firstInvalidStep, formFromCamera, hostProblem, MASK, streamPathProblem, summarize, tlsState,
  toDraft, validateStep, type CameraForm,
} from "./logic";
import type { RegistryCamera } from "./types";

const valid: CameraForm = {
  ...emptyForm("city-1"), name: "Gate 1", kind: "anpr_camera", latitude: "34.02", longitude: "-6.84",
  protocol: "rtsps", host: "10.20.0.11", port: "322", streamPath: "/stream1",
};

function camera(over: Partial<RegistryCamera> = {}): RegistryCamera {
  return {
    id: "c1", cityId: "city-1", name: "Gate 1", kind: "anpr_camera", district: null, streetAddress: null, latitude: 34, longitude: -6.8,
    viewDirectionDeg: null, lane: null, installedOn: null, owner: null, host: "10.0.0.1", port: 554, protocol: "rtsp", streamPath: "/s",
    vlan: null, firmwareVersion: null, credentialsSet: true, status: "online", lastFrameAt: null, tlsNotAfter: null, notes: null,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...over,
  };
}

describe("assembled URL preview", () => {
  it("always masks credentials and never contains anything typed", () => {
    const url = assembledUrlPreview({ protocol: "rtsps", host: "10.20.0.11", port: 322, streamPath: "/stream1", withCredentials: true });
    expect(url).toBe(`rtsps://${MASK}:${MASK}@10.20.0.11:322/stream1`);
  });
  it("omits the credential part when none are set, and uses default ports", () => {
    expect(assembledUrlPreview({ protocol: "rtsp", host: "cam.local", withCredentials: false })).toBe("rtsp://cam.local:554");
  });
  it("brackets IPv6 and returns null for sources without a URL", () => {
    expect(assembledUrlPreview({ protocol: "rtsps", host: "2001:db8::1", withCredentials: false })).toBe("rtsps://[2001:db8::1]:322");
    expect(assembledUrlPreview({ protocol: "webhook", host: "x", withCredentials: true })).toBeNull();
    expect(assembledUrlPreview({ protocol: "rtsp", host: "", withCredentials: true })).toBeNull();
  });
  it("has no parameter that could carry a real secret", () => {
    // The function takes a boolean, not credentials: a typed password cannot reach the preview.
    expect(assembledUrlPreview.length).toBe(1);
  });
});

describe("host and stream path rules (mirror the server)", () => {
  it.each(["rtsp://10.0.0.5", "admin:pw@10.0.0.5", "10.0.0.5:554", "cam.local/x", "cam local", "-cam.local", "999.1.1.1", ""])("rejects %j", (h) => {
    expect(hostProblem(h)).not.toBeNull();
  });
  it.each(["10.0.0.5", "2001:db8::1", "[2001:db8::1]", "cam-01.rabat.local", "camera"])("accepts %j", (h) => {
    expect(hostProblem(h)).toBeNull();
  });
  it.each(["rtsp://x/s", "/u:p@s", "stream", "/live?password=x", "/a?user=admin", "/a b"])("rejects stream path %j", (p) => {
    expect(streamPathProblem(p)).not.toBeNull();
  });
  it("accepts a harmless query string and an empty path", () => {
    expect(streamPathProblem("/cam/realmonitor?channel=1&subtype=0")).toBeNull();
    expect(streamPathProblem("")).toBeNull();
  });
});

describe("wizard validation", () => {
  it("passes a complete form", () => {
    expect(firstInvalidStep(valid, false)).toBeNull();
  });
  it("stops at the first invalid step", () => {
    expect(firstInvalidStep({ ...valid, name: "" }, false)).toBe(0);
    expect(firstInvalidStep({ ...valid, latitude: "91" }, false)).toBe(1);
    expect(firstInvalidStep({ ...valid, host: "rtsp://x" }, false)).toBe(2);
    expect(firstInvalidStep({ ...valid, credUsername: "u" }, false)).toBe(3);
  });
  it("checks ranges", () => {
    expect(validateStep(1, { ...valid, longitude: "-181" }, false).longitude).toBeTruthy();
    expect(validateStep(1, { ...valid, viewDirectionDeg: "360" }, false).viewDirectionDeg).toBeTruthy();
    expect(validateStep(2, { ...valid, port: "65536" }, false).port).toBeTruthy();
    expect(validateStep(2, { ...valid, vlan: "4095" }, false).vlan).toBeTruthy();
  });
  it("does not require a host for webhook sources", () => {
    expect(validateStep(2, { ...valid, protocol: "webhook", host: "" }, false)).toEqual({});
  });
  it("never puts credentials in the camera body", () => {
    const body = toDraft({ ...valid, credUsername: "admin", credPassword: "s3cret!" });
    expect(JSON.stringify(body)).not.toContain("s3cret!");
    expect(JSON.stringify(body)).not.toContain("admin");
  });
  it("never prefills credentials when editing", () => {
    const f = formFromCamera(camera({ credentialsSet: true }));
    expect(f.credUsername).toBe("");
    expect(f.credPassword).toBe("");
  });
});

describe("health", () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  it("classifies TLS expiry", () => {
    expect(tlsState(null, now)).toBe("none");
    expect(tlsState("2026-10-01T00:00:00Z", now)).toBe("expired");
    expect(tlsState("2026-10-20T00:00:00Z", now)).toBe("expiring");
    expect(tlsState("2027-01-01T00:00:00Z", now)).toBe("ok");
  });
  it("summarizes, ignoring credentials for sources that need none", () => {
    const s = summarize([camera(), camera({ id: "2", status: "offline", credentialsSet: false }), camera({ id: "3", protocol: "webhook", credentialsSet: false })], 1);
    expect(s).toMatchObject({ cameras: 3, online: 2, offline: 1, credentialsMissing: 1 });
  });
  it("computes city health without maintenance cameras", () => {
    expect(cityHealth([camera(), camera({ status: "degraded" }), camera({ status: "maintenance" })])).toBe(0.75);
    expect(cityHealth([camera({ status: "maintenance" })])).toBeNull();
  });
});

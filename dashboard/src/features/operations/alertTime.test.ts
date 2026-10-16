import { describe, expect, it } from "vitest";
import { formatWait, SLOW_WAIT_S, waitedSeconds } from "./alertTime";

const at = (secondsAgo: number, now: number) => new Date(now - secondsAgo * 1000).toISOString();

describe("alert waiting time", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");

  it("shows minutes:seconds under an hour, hours and minutes under a day, then days", () => {
    expect(formatWait(at(42, now), now)).toBe("0:42");
    expect(formatWait(at(12 * 60 + 40, now), now)).toBe("12:40");
    expect(formatWait(at(2 * 3600 + 5 * 60, now), now)).toBe("2 h 05");
    expect(formatWait(at(3 * 86400 + 100, now), now)).toBe("3 d");
  });

  it("never shows a negative wait when the camera clock runs ahead", () => {
    expect(formatWait(at(-30, now), now)).toBe("0:00");
  });

  it("flags waits past the slow threshold", () => {
    expect(waitedSeconds(at(SLOW_WAIT_S + 1, now), now)).toBeGreaterThan(SLOW_WAIT_S);
    expect(waitedSeconds(at(60, now), now)).toBeLessThan(SLOW_WAIT_S);
  });
});

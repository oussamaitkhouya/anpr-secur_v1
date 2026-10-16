"""Small fixed-window rate limiter, in memory.

    limiter.hit("login", client_ip, limit=10)   -> None, or seconds to wait

Each (bucket, key) gets `limit` requests per 60-second window. Simple to read and to test.
Known limit: the counters live in one process. With several workers or servers, each has its
own counters; production would move this to Redis or to the reverse proxy (documented in
docs/security_design.md).
"""

import threading
import time


class RateLimiter:
    def __init__(self, window_seconds: int = 60, clock=time.monotonic):
        self.window = window_seconds
        self.clock = clock
        self._counts: dict[tuple[str, str], tuple[int, int]] = {}  # (bucket, key) -> (window index, count)
        self._lock = threading.Lock()

    def hit(self, bucket: str, key: str, limit: int) -> int | None:
        """Count one request. Return None if allowed, else seconds until the window resets."""
        now = self.clock()
        window = int(now // self.window)
        with self._lock:
            if len(self._counts) > 100_000:  # keep memory bounded under a flood of distinct keys
                self._counts = {k: v for k, v in self._counts.items() if v[0] == window}
            seen_window, count = self._counts.get((bucket, key), (window, 0))
            if seen_window != window:
                count = 0
            count += 1
            self._counts[(bucket, key)] = (window, count)
        if count > limit:
            return max(1, int(self.window - (now % self.window)))
        return None

    def reset(self) -> None:
        with self._lock:
            self._counts.clear()

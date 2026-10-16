import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../app/session";
import { ApiError } from "./errors";
import type { RequestContext } from "./types";

export interface Loadable<T> {
  data?: T;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Run an API call for the signed-in user and re-run it when `deps`, the user or their role
 * change. Stale responses are dropped. A 401 ends the session (back to the login page).
 */
export function useApi<T>(fn: (ctx: RequestContext) => Promise<T>, deps: readonly unknown[] = []): Loadable<T> {
  const { token, user, expire } = useSession();
  const [state, setState] = useState<{ data?: T; error: unknown; loading: boolean }>({ error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef.current({ token })
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.status === 401) expire();
        setState({ data: undefined, error, loading: false });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller
  }, [token, user.role, user.allowedCityIds.join(","), tick, ...deps]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** RequestContext for imperative calls (button handlers). */
export function useRequestContext(): RequestContext {
  const { token } = useSession();
  return { token };
}

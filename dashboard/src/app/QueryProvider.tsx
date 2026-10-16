import { useState, type ReactNode } from "react";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../api/errors";
import { useSession } from "./session";

/**
 * TanStack Query for pages on the real API. One client per signed-in user (keyed below), so a
 * sign-out or a user switch can never show the previous user's cached cameras. A 401 from any
 * query or mutation ends the session. 403/404 are not retried: they will not change.
 */
function Provider({ children }: { children: ReactNode }) {
  const { expire } = useSession();
  const [client] = useState(() => {
    const on401 = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) expire();
    };
    return new QueryClient({
      queryCache: new QueryCache({ onError: on401 }),
      mutationCache: new MutationCache({ onError: on401 }),
      defaultOptions: {
        queries: {
          staleTime: 20_000,
          refetchOnWindowFocus: false,
          retry: (count, error) => !(error instanceof ApiError && [401, 403, 404, 422].includes(error.status)) && count < 2,
        },
      },
    });
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  return <Provider key={user.id}>{children}</Provider>;
}

import { onlineManager, QueryClient } from "@tanstack/react-query";
import { ApiRequestError, isEngineUnavailable } from "@/lib/api";
import { getEngineStatus, subscribeEngineStatus } from "@/lib/engine-status";

/**
 * Retrying a 4xx gives the same answer (unknown torrent, bad input), so only
 * a missing engine, network trouble and 5xx get retries. Queries that need
 * something else (media info waiting for metadata) set their own `retry`.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  // The engine is restarting. Retries wait until it's back (see below), so
  // a few are enough.
  if (isEngineUnavailable(error)) return failureCount < 3;
  if (
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500
  ) {
    return false;
  }
  return failureCount < 2;
}

/**
 * Mutations change things, so they only retry when the engine wasn't there
 * to receive them at all.
 */
export function shouldRetryMutation(
  failureCount: number,
  error: unknown,
): boolean {
  return isEngineUnavailable(error) && failureCount < 3;
}

/**
 * React Query calls a missing network "offline": queries and mutations wait
 * (fetchStatus "paused") instead of failing, and refetch when it's back. For
 * Streamy the network that matters is the engine, a local process, so
 * "online" means "the engine is running". The computer's own Wi-Fi doesn't
 * matter: playing what's already downloaded works without it.
 *
 * Before the main process has answered, it counts as online: the first
 * requests either work or fail fast with a 503 and wait for the engine.
 */
export function followEngineStatus(): void {
  onlineManager.setEventListener((setOnline) => {
    const update = () => {
      const status = getEngineStatus();
      setOnline(status === null || status.state === "running");
    };
    update();
    return subscribeEngineStatus(update);
  });
}

export function createQueryClient(): QueryClient {
  followEngineStatus();
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry },
      mutations: { retry: shouldRetryMutation },
    },
  });
}

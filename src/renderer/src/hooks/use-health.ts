import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** How often to ask the engine how it's doing (e.g. is the disk full?). */
export const HEALTH_INTERVAL_MS = 30_000;

export const healthQuery = () =>
  queryOptions({
    queryKey: ["health"],
    queryFn: ({ signal }) => api.getHealth(signal),
    // Only while the window is visible (React Query's default): nobody
    // reads the banner of a hidden window.
    refetchInterval: HEALTH_INTERVAL_MS,
  });

/** The engine's version, ffmpeg, encoder and free-space state. */
export function useHealth() {
  return useQuery(healthQuery());
}

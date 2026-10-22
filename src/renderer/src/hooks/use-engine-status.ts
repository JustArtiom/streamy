import { useSyncExternalStore } from "react";
import type { EngineStatus } from "../../../shared/api";
import { getEngineStatus, subscribeEngineStatus } from "@/lib/engine-status";

/**
 * The playback engine's state (starting / running / restarting / failed),
 * or null for the moment before the main process has answered.
 */
export function useEngineStatus(): EngineStatus | null {
  return useSyncExternalStore(subscribeEngineStatus, getEngineStatus);
}

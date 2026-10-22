import type { EngineStatus } from "../../../shared/api";

// The playback engine's state, as the main process reports it. A plain
// store (not React state) so non-React code can read it too: the API client
// uses it to tell "the engine is down" from other errors, and React Query
// pauses while it's down (see query-client.ts).

type Listener = (status: EngineStatus | null) => void;

/** null until the main process has answered (a moment after start). */
let current: EngineStatus | null = null;
/** It was running at some point since this window opened. */
let hasRun = false;
let heardChange = false;
const listeners = new Set<Listener>();

function set(next: EngineStatus) {
  current = next;
  if (next.state === "running") hasRun = true;
  for (const listener of listeners) listener(next);
}

// Start listening right away (before React renders), so nothing is missed.
window.streamy.engine.onStatusChange((status) => {
  heardChange = true;
  set(status);
});
window.streamy.engine
  .getStatus()
  .then((status) => {
    // A change that arrived meanwhile is newer than this answer.
    if (!heardChange) set(status);
  })
  .catch((error: unknown) => {
    console.error("Could not read the engine status:", error);
  });

export function getEngineStatus(): EngineStatus | null {
  return current;
}

/**
 * True once the engine has answered since this window opened. "starting"
 * before that is the normal launch; after it, the engine had stopped.
 */
export function engineHasRun(): boolean {
  return hasRun;
}

/** True when requests can reach the engine now (unknown counts as no). */
export function isEngineRunning(): boolean {
  return current?.state === "running";
}

export function subscribeEngineStatus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests: start over as if the window had just opened (status unknown). */
export function resetEngineStatusForTests(): void {
  current = null;
  hasRun = false;
  for (const listener of listeners) listener(null);
}

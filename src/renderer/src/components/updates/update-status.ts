import { useSyncExternalStore } from "react";
import type { UpdateStatus } from "../../../../shared/api";

// Streamy's update status, as the main process reports it (src/main/updates).
// One store for the window, so the title bar's update button and Settings →
// Advanced always say the same thing.

type Listener = () => void;

/** null until the main process has answered (a moment after start). */
let current: UpdateStatus | null = null;
let heardChange = false;
const listeners = new Set<Listener>();

function set(next: UpdateStatus): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Start listening right away (before React renders), so nothing is missed.
window.streamy.updates.onStatusChange((status) => {
  heardChange = true;
  set(status);
});
window.streamy.updates
  .getStatus()
  .then((status) => {
    // A change that arrived meanwhile is newer than this answer.
    if (!heardChange) set(status);
  })
  .catch((error: unknown) => {
    console.error("Could not read the update status:", error);
  });

export function useUpdateStatus(): UpdateStatus | null {
  return useSyncExternalStore(subscribe, () => current);
}

/** Checks now (Settings → "Check for updates") and keeps the answer. */
export async function checkForUpdates(): Promise<void> {
  set(await window.streamy.updates.check());
}

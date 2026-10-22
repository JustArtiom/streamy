import { useSyncExternalStore } from "react";
import type { UpdateStatus } from "../../../../shared/api";

// Streamy's update status, as the main process reports it (src/main/updates).
// One store for the window, so the notice under the title bar and Settings →
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

// The notice under the title bar (update-notice.tsx) can be dismissed for the
// rest of the session: "ready 0.2.0", "available 0.2.0". A new version or a
// new step shows it again.
const dismissed = new Set<string>();
const dismissedListeners = new Set<Listener>();

function subscribeDismissed(listener: Listener): () => void {
  dismissedListeners.add(listener);
  return () => {
    dismissedListeners.delete(listener);
  };
}

export function dismissUpdateNotice(key: string): void {
  dismissed.add(key);
  for (const listener of dismissedListeners) listener();
}

export function useUpdateNoticeDismissed(key: string | null): boolean {
  return useSyncExternalStore(
    subscribeDismissed,
    () => key !== null && dismissed.has(key),
  );
}

/** Tests: forget dismissed notices, as if Streamy had just started. */
export function resetUpdateNoticeForTests(): void {
  dismissed.clear();
  for (const listener of dismissedListeners) listener();
}

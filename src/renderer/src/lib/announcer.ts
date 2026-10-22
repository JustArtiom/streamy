import { useSyncExternalStore } from "react";

// What the app-wide live region (components/layout/announcer.tsx) says.
// Screen readers often skip a live region that appears together with its
// text, so banners don't carry their own: they put their text here, in a
// region that's always in the page, and take it out when they go away.

export type Announcement = { id: string; text: string };

let announcements: readonly Announcement[] = [];
const listeners = new Set<() => void>();

function emit(next: readonly Announcement[]) {
  announcements = next;
  for (const listener of listeners) listener();
}

/**
 * Sets (or with null, removes) what the source `id` says. Same text again
 * does nothing, so it isn't announced twice.
 */
export function announce(id: string, text: string | null): void {
  const index = announcements.findIndex((item) => item.id === id);
  const current = announcements[index];
  if (text === null || text.trim() === "") {
    if (index !== -1) emit(announcements.filter((item) => item.id !== id));
    return;
  }
  if (current?.text === text) return;
  emit(
    current
      ? announcements.map((item) => (item.id === id ? { id, text } : item))
      : [...announcements, { id, text }],
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAnnouncements(): readonly Announcement[] {
  return useSyncExternalStore(subscribe, () => announcements);
}

/** Tests: start with nothing said. */
export function resetAnnouncerForTests(): void {
  emit([]);
}

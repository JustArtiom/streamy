import { useSyncExternalStore } from "react";
import { NavigationType } from "react-router";

// Where this window is in its own page history, so the title bar knows
// whether Back and Forward can go anywhere. Neither the browser nor React
// Router can tell whether there's a page to go forward to, so Streamy keeps
// the list of pages itself (by React Router's location keys) as the router
// moves. hooks/use-history-nav.ts feeds it on every page change.

export interface HistoryPosition {
  /** The location keys of the pages visited, oldest first. */
  keys: readonly string[];
  /** Which of them is showing. -1 before the first page. */
  index: number;
}

const EMPTY: HistoryPosition = { keys: [], index: -1 };

let position: HistoryPosition = EMPTY;
const listeners = new Set<() => void>();

function set(next: HistoryPosition): void {
  position = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A page change: its location key, and how the router got there. */
export function recordNavigation(key: string, type: NavigationType): void {
  const { keys, index } = position;
  // The same page again (React runs effects twice in development).
  if (keys[index] === key) return;
  if (index === -1) {
    set({ keys: [key], index: 0 });
    return;
  }
  switch (type) {
    case NavigationType.Push:
      // A new page drops the ones you had gone back from, like a browser.
      set({ keys: [...keys.slice(0, index + 1), key], index: index + 1 });
      return;
    case NavigationType.Replace:
      set({ keys: keys.map((k, i) => (i === index ? key : k)), index });
      return;
    case NavigationType.Pop: {
      const found = keys.indexOf(key);
      // A page we never saw (it shouldn't happen): start over from it.
      set(found === -1 ? { keys: [key], index: 0 } : { keys, index: found });
      return;
    }
  }
}

export function useHistoryPosition(): HistoryPosition {
  return useSyncExternalStore(subscribe, () => position);
}

/** Tests: forget the history, as if the window had just opened. */
export function resetHistoryForTests(): void {
  set(EMPTY);
}

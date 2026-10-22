import { useSyncExternalStore } from "react";

// Whether the window itself is in full screen (the green button, View →
// Enter Full Screen, F11, ⌃⌘F), as the main process reports it. A store
// that starts listening at once, like the engine status: a change that
// happens before a page renders isn't lost.

let fullScreen = false;
/** A change was reported: it's newer than the answer to the first question. */
let changed = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (next === fullScreen) return;
  fullScreen = next;
  for (const listener of listeners) listener();
}

window.streamy.onFullScreenChange((next) => {
  changed = true;
  set(next);
});

// The main process only reports changes: ask once, for a page that loads
// in a window already in full screen (a reload).
window.streamy.window.isFullScreen().then(
  (current) => {
    if (!changed) set(current);
  },
  () => {
    // An older main process without the handler: changes still arrive.
  },
);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while the window is in full screen. */
export function useWindowFullScreen(): boolean {
  return useSyncExternalStore(subscribe, () => fullScreen);
}

/**
 * Puts the window in or out of full screen. The page can't leave OS full
 * screen by itself (document.exitFullscreen only ends what the page
 * started). Best effort: nothing to tell the viewer if it can't.
 */
export function setWindowFullScreen(on: boolean): void {
  window.streamy.window.setFullScreen(on).catch(() => undefined);
}

/** Tests: back to a normal window. */
export function resetFullScreenForTests(): void {
  set(false);
}

import { useEffect, useEffectEvent } from "react";

export type ShortcutActions = {
  togglePlay: () => void;
  seekBy: (seconds: number) => void;
  volumeBy: (delta: number) => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  toggleSubtitles: () => void;
  /** 0–9 → 0 %–90 % of the movie. */
  seekToFraction: (fraction: number) => void;
  speedBy: (direction: -1 | 1) => void;
  /** Close whatever is open (menus, stats), or leave full screen. */
  escape: () => void;
};

/** Typing in a field must never pause the movie. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/** A dialog (e.g. Settings) is on top: the player behind it isn't in use. */
function isDialogOpen() {
  return document.querySelector("dialog[open]") !== null;
}

/** Keys that flip something: holding them down shouldn't flip it back and forth. */
const TOGGLES = new Set([" ", "k", "m", "f", "c"]);

/**
 * Space/K play-pause · ←/→ ∓5 s · J/L ∓10 s · ↑/↓ volume · M mute ·
 * F full screen · C subtitles · 0–9 jump · < > speed · Esc closes menus.
 *
 * Only plain keys (Shift is fine, "<" needs it): anything with ⌘, Ctrl or
 * Alt belongs to the menu (zoom, Settings…) or to Back (⌘[, Alt+←). Never
 * while typing or while a dialog is open.
 * Returns the action that ran (for tests), or null.
 */
export function handleShortcut(
  event: Pick<
    KeyboardEvent,
    | "key"
    | "ctrlKey"
    | "metaKey"
    | "altKey"
    | "target"
    | "defaultPrevented"
    | "repeat"
  >,
  actions: ShortcutActions,
): string | null {
  if (
    event.defaultPrevented ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) {
    return null;
  }
  if (isTypingTarget(event.target) || isDialogOpen()) return null;

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (event.repeat && TOGGLES.has(key)) return null;
  switch (key) {
    case " ":
    case "k":
      actions.togglePlay();
      return "togglePlay";
    case "ArrowLeft":
      actions.seekBy(-5);
      return "seekBy";
    case "ArrowRight":
      actions.seekBy(5);
      return "seekBy";
    case "j":
      actions.seekBy(-10);
      return "seekBy";
    case "l":
      actions.seekBy(10);
      return "seekBy";
    case "ArrowUp":
      actions.volumeBy(0.05);
      return "volumeBy";
    case "ArrowDown":
      actions.volumeBy(-0.05);
      return "volumeBy";
    case "m":
      actions.toggleMute();
      return "toggleMute";
    case "f":
      actions.toggleFullscreen();
      return "toggleFullscreen";
    case "c":
      actions.toggleSubtitles();
      return "toggleSubtitles";
    case "<":
      actions.speedBy(-1);
      return "speedBy";
    case ">":
      actions.speedBy(1);
      return "speedBy";
    case "Escape":
      actions.escape();
      return "escape";
  }
  if (/^[0-9]$/.test(key)) {
    actions.seekToFraction(Number(key) / 10);
    return "seekToFraction";
  }
  return null;
}

/** The player's keys, while it's on screen. */
export function usePlayerShortcuts(actions: ShortcutActions) {
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (handleShortcut(event, actions)) {
      // No page scrolling on arrows/space, no button "click" on space.
      event.preventDefault();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);
}

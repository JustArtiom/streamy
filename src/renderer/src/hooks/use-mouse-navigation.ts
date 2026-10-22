import { useEffect, useEffectEvent } from "react";
import { useHistoryNav } from "@/hooks/use-history-nav";

/** MouseEvent.button of the mouse's "back" and "forward" side buttons. */
export const MOUSE_BACK_BUTTON = 3;
export const MOUSE_FORWARD_BUTTON = 4;

/**
 * The mouse's back and forward buttons work anywhere in the window, like in
 * a browser. Not while a dialog (e.g. Settings) is open: the page behind it
 * shouldn't change.
 */
export function useMouseNavigation(): void {
  const { goBack, goForward } = useHistoryNav();

  const onMouseUp = useEffectEvent((event: MouseEvent) => {
    const go =
      event.button === MOUSE_BACK_BUTTON
        ? goBack
        : event.button === MOUSE_FORWARD_BUTTON
          ? goForward
          : null;
    if (!go) return;
    // Nothing else should act on it (Chromium may navigate by itself on
    // some systems, which would move twice).
    event.preventDefault();
    if (document.querySelector("dialog[open]")) return;
    go();
  });

  useEffect(() => {
    // Only mouseup: auxclick fires for the same press, which would move
    // twice.
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}

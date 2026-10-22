import { useEffect, useEffectEvent } from "react";
import { useGoBack } from "@/hooks/use-go-back";

/** MouseEvent.button of the mouse's "back" side button. */
export const MOUSE_BACK_BUTTON = 3;

/**
 * The mouse's back button goes back, anywhere in the window, like in a
 * browser. Not while a dialog (e.g. Settings) is open: the page behind it
 * shouldn't change.
 */
export function useMouseBackButton(): void {
  const goBack = useGoBack();

  const onMouseUp = useEffectEvent((event: MouseEvent) => {
    if (event.button !== MOUSE_BACK_BUTTON) return;
    // Nothing else should act on it (Chromium may go back by itself on
    // some systems, which would go back twice).
    event.preventDefault();
    if (document.querySelector("dialog[open]")) return;
    goBack();
  });

  useEffect(() => {
    // Only mouseup: auxclick fires for the same press, which would go back
    // twice.
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);
}

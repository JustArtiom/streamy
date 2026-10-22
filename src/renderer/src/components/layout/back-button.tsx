import { ArrowLeft } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { Button } from "@/components/ui/button";
import { useGoBack } from "@/hooks/use-go-back";
import { isMac } from "@/lib/platform";

const SHORTCUT = isMac ? "⌘[" : "Alt+←";

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** The title bar's Back button, with the usual shortcut (⌘[ or Alt+←). */
export function BackButton() {
  const goBack = useGoBack();

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const pressed = isMac
      ? event.metaKey && !event.altKey && event.key === "["
      : event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.key === "ArrowLeft";
    if (!pressed || event.defaultPrevented || isTypingTarget(event.target)) {
      return;
    }
    // A dialog (e.g. Settings) is on top: the page behind shouldn't change.
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    goBack();
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Back"
      aria-keyshortcuts={isMac ? "Meta+BracketLeft" : "Alt+ArrowLeft"}
      title={`Back (${SHORTCUT})`}
      className="no-drag-region"
      onClick={goBack}
    >
      <ArrowLeft />
    </Button>
  );
}

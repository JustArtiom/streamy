import { ArrowLeft, ArrowRight } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { Button } from "@/components/ui/button";
import { useHistoryNav } from "@/hooks/use-history-nav";
import { isMac } from "@/lib/platform";

const BACK_SHORTCUT = isMac ? "⌘[" : "Alt+←";
const FORWARD_SHORTCUT = isMac ? "⌘]" : "Alt+→";

function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

/** ⌘[ / ⌘] on macOS, Alt+← / Alt+→ elsewhere (the usual browser keys). */
function shortcutDirection(event: KeyboardEvent): "back" | "forward" | null {
  if (isMac) {
    if (!event.metaKey || event.altKey || event.ctrlKey) return null;
    if (event.key === "[") return "back";
    if (event.key === "]") return "forward";
    return null;
  }
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}

/**
 * The title bar's Back and Forward buttons, on every page. Greyed out when
 * there's nowhere to go, so they never jump around.
 */
export function NavButtons() {
  const { canGoBack, canGoForward, goBack, goForward } = useHistoryNav();

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const direction = shortcutDirection(event);
    if (!direction || event.defaultPrevented || isTypingTarget(event.target)) {
      return;
    }
    // A dialog (e.g. Settings) is on top: the page behind shouldn't change.
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    if (direction === "back") goBack();
    else goForward();
  });

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back"
        aria-keyshortcuts={isMac ? "Meta+BracketLeft" : "Alt+ArrowLeft"}
        title={`Back (${BACK_SHORTCUT})`}
        className="no-drag-region"
        disabled={!canGoBack}
        onClick={goBack}
      >
        <ArrowLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Forward"
        aria-keyshortcuts={isMac ? "Meta+BracketRight" : "Alt+ArrowRight"}
        title={`Forward (${FORWARD_SHORTCUT})`}
        className="no-drag-region"
        disabled={!canGoForward}
        onClick={goForward}
      >
        <ArrowRight />
      </Button>
    </>
  );
}

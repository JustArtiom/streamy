import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import { TITLE_BAR_HEIGHT } from "../../../shared/api";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { UpdateButton } from "@/components/updates/update-button";
import { cn } from "@/lib/cn";
import { useWindowFullScreen } from "@/lib/full-screen";
import { isMac } from "@/lib/platform";
import { openSettings } from "@/lib/settings";

/**
 * Our own title bar. The OS window buttons stay native:
 * - macOS: the traffic lights sit on the left, inside this bar.
 * - Windows/Linux: minimize/maximize/close are drawn over the right side.
 * Left: Back/Forward. Middle: the logo, centered on the window like a macOS
 * title. Right: the update button and Settings.
 * The whole bar drags the window; buttons opt out with no-drag-region.
 */
export function TitleBar({
  navigation,
}: {
  /** Shown on the left, e.g. Back and Forward. Mark it no-drag-region. */
  navigation?: ReactNode;
}) {
  const fullScreen = useWindowFullScreen();

  return (
    <header
      className="relative flex shrink-0 border-b border-border bg-background window-controls-safe-area drag-region select-none"
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      {/* Centered on the whole window, not on the space between the
          buttons. Clicks go through it to the bar, so it still drags. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2">
        <Logo className="size-[18px]" />
        <span className="text-[13px] font-semibold tracking-tight">
          Streamy
        </span>
      </div>

      <div
        className={cn(
          "relative flex min-w-0 flex-1 items-center justify-between gap-3 pr-3 pl-3",
          // macOS: room for the traffic lights (they hide in full screen),
          // plus a ~24 px gap after them.
          isMac && !fullScreen && "pl-[92px]",
        )}
      >
        <div className="flex items-center gap-1">{navigation}</div>

        <div className="flex items-center gap-1">
          {/* Only there when an update is ready (or, on macOS, available). */}
          <UpdateButton />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Settings"
            title="Settings"
            className="no-drag-region"
            onClick={() => {
              openSettings();
            }}
          >
            <Settings />
          </Button>
        </div>
      </div>
    </header>
  );
}

import { Settings } from "lucide-react";
import type { ReactNode } from "react";
import { TITLE_BAR_HEIGHT } from "../../../shared/api";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useWindowFullScreen } from "@/lib/full-screen";
import { isMac } from "@/lib/platform";
import { openSettings } from "@/lib/settings";

/**
 * Our own title bar. The OS window buttons stay native:
 * - macOS: the traffic lights sit on the left, inside this bar.
 * - Windows/Linux: minimize/maximize/close are drawn over the right side.
 * The whole bar drags the window; buttons opt out with no-drag-region.
 */
export function TitleBar({
  navigation,
}: {
  /** Shown after the logo, e.g. the Back button. Mark it no-drag-region. */
  navigation?: ReactNode;
}) {
  const fullScreen = useWindowFullScreen();

  return (
    <header
      className="flex shrink-0 border-b border-border bg-background window-controls-safe-area drag-region select-none"
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center justify-between gap-3 pr-3 pl-3",
          // macOS: room for the traffic lights (they hide in full screen),
          // plus a ~24 px gap after them.
          isMac && !fullScreen && "pl-[92px]",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Logo className="size-[18px]" />
          <span className="truncate text-[13px] font-semibold tracking-tight">
            Streamy
          </span>
          {navigation && (
            <div className="ml-1 flex items-center gap-1">{navigation}</div>
          )}
        </div>

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
    </header>
  );
}

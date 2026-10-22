import { useEffect, useRef } from "react";
import { Outlet, useLocation, useMatches } from "react-router";
import { Announcer } from "@/components/layout/announcer";
import { BackButton } from "@/components/layout/back-button";
import { DropZone } from "@/components/layout/drop-zone";
import { EngineBanner } from "@/components/layout/engine-banner";
import { IncomingLinks } from "@/components/layout/incoming-links";
import { IpNoticeBanner } from "@/components/layout/ip-notice-banner";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { TitleBar } from "@/components/title-bar";
import { useMouseBackButton } from "@/hooks/use-mouse-back";
import { cn } from "@/lib/cn";
import { useWindowFullScreen } from "@/lib/full-screen";

/**
 * What a route can tell the layout, through its `handle` (see router.tsx).
 * `fullBleed`: the page fills the whole area under the title bar, with no
 * page scroll (the player). Its root should be `flex-1` (or absolute
 * inset-0): <main> is a flex column, `relative`.
 */
export type RouteHandle = { fullBleed?: boolean };

function isFullBleed(handle: unknown): boolean {
  return (
    typeof handle === "object" &&
    handle !== null &&
    (handle as RouteHandle).fullBleed === true
  );
}

/**
 * Every page: the title bar (with Back everywhere but Home), news banners,
 * then the page. Settings, drag and drop and links from outside work from
 * any page, and so does the mouse's back button.
 *
 * When the window is in full screen on a full-bleed page (the player), the
 * title bar and banners make way, so the video gets the whole screen
 * (PLAN §13, decision 5). They come back when the window leaves full screen
 * or the page changes. (The player's own full screen, F or double-click,
 * covers everything anyway.)
 */
export function AppLayout() {
  const location = useLocation();
  const fullBleed = useMatches().some((match) => isFullBleed(match.handle));
  const windowFullScreen = useWindowFullScreen();
  const chromeHidden = fullBleed && windowFullScreen;
  const isHome = location.pathname === "/";
  const main = useRef<HTMLElement>(null);
  useMouseBackButton();

  // <main> scrolls, not the window, and it stays mounted between pages:
  // start each page at the top.
  useEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [location.pathname]);

  return (
    <div className="flex h-dvh flex-col">
      {/* Hidden rather than removed, so Back's shortcut (⌘[) keeps working.
          (Tailwind's base styles make [hidden] win over "contents".) */}
      <div hidden={chromeHidden} className="contents">
        <TitleBar navigation={isHome ? undefined : <BackButton />} />
        <EngineBanner />
        <IpNoticeBanner />
      </div>
      <main
        ref={main}
        className={cn(
          "relative flex min-h-0 flex-1 flex-col",
          fullBleed ? "overflow-hidden" : "overflow-y-auto",
        )}
      >
        <Outlet />
      </main>
      {/* Says what the banners say, for screen readers. Outside the part
          that hides in full screen, so news still gets through. */}
      <Announcer />
      <SettingsDialog />
      <DropZone />
      <IncomingLinks />
    </div>
  );
}

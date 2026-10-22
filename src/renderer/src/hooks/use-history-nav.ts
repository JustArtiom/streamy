import { useEffect } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import { recordNavigation, useHistoryPosition } from "@/lib/history-stack";

/** Keeps lib/history-stack up to date. Mounted once, in AppLayout. */
export function useTrackHistory(): void {
  const { key } = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    recordNavigation(key, type);
  }, [key, type]);
}

export interface HistoryNav {
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
}

/**
 * Back and Forward, like a browser's. One difference: when there's nothing
 * to go back to in Streamy (the window opened on this page, e.g. after a
 * reload or a link from outside), Back goes Home. So Back is only
 * unavailable on Home with nothing before it.
 */
export function useHistoryNav(): HistoryNav {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { keys, index } = useHistoryPosition();
  const hasPrevious = index > 0;
  const hasNext = index >= 0 && index < keys.length - 1;
  const isHome = pathname === "/";

  return {
    canGoBack: hasPrevious || !isHome,
    canGoForward: hasNext,
    goBack: () => {
      if (hasPrevious) void navigate(-1);
      else if (!isHome) void navigate("/", { replace: true });
    },
    goForward: () => {
      if (hasNext) void navigate(1);
    },
  };
}

/** Just Back (the player's own Back button uses it). */
export function useGoBack(): () => void {
  return useHistoryNav().goBack;
}

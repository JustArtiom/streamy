import { z } from "zod";
import { TITLE_BAR_HEIGHT } from "../shared/api";
import { readJsonFile, writeJsonFile } from "./storage/json-file";

// Remembers the main window's size and position between launches.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  width: number;
  height: number;
  /** Missing = let the OS place the window (centered). */
  x?: number;
  y?: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW_SIZE = { width: 1200, height: 780 };
export const MIN_WINDOW_SIZE = { width: 720, height: 480 };

/** How much of the title bar must be on a screen so the window can be dragged. */
const GRAB_AREA = { width: 120, height: 24 };

const savedStateSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  maximized: z.boolean().catch(false),
});

function titleBarVisibleOn(window: Rect, screen: Rect): boolean {
  const overlapX =
    Math.min(window.x + window.width, screen.x + screen.width) -
    Math.max(window.x, screen.x);
  const overlapY =
    Math.min(window.y + TITLE_BAR_HEIGHT, screen.y + screen.height) -
    Math.max(window.y, screen.y);
  return overlapX >= GRAB_AREA.width && overlapY >= GRAB_AREA.height;
}

/**
 * Keeps a restored window usable: its title bar must be on a screen that's
 * still connected (a monitor may have been unplugged), and it can't be
 * bigger than that screen. `screens` are work areas, primary screen first.
 */
export function fitToScreens(state: WindowState, screens: Rect[]): WindowState {
  const width = Math.max(MIN_WINDOW_SIZE.width, state.width);
  const height = Math.max(MIN_WINDOW_SIZE.height, state.height);
  const { x, y, maximized } = state;

  const home =
    x !== undefined && y !== undefined
      ? screens.find((screen) =>
          titleBarVisibleOn({ x, y, width, height }, screen),
        )
      : undefined;
  const fallback = home ?? screens[0];
  const fitted = {
    width: fallback ? Math.min(width, fallback.width) : width,
    height: fallback ? Math.min(height, fallback.height) : height,
    maximized,
  };
  // Off every screen: drop the position and let the OS center it.
  return home ? { ...fitted, x, y } : fitted;
}

export function loadWindowState(file: string, screens: Rect[]): WindowState {
  const read = readJsonFile(file);
  const saved = savedStateSchema.safeParse(
    read.status === "ok" ? read.data : undefined,
  );
  const state = saved.success
    ? saved.data
    : { ...DEFAULT_WINDOW_SIZE, maximized: false };
  return fitToScreens(state, screens);
}

export function saveWindowState(
  file: string,
  state: Required<WindowState>,
): void {
  try {
    writeJsonFile(file, state);
  } catch (error) {
    // Not worth interrupting closing the window for.
    console.warn("[window-state] Could not save the window position:", error);
  }
}

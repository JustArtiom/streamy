// Settings types shared by the main process, the preload script and the UI.
// No runtime dependencies here: the sandboxed preload can't load packages.
//
// Adding a setting:
//   1. Add it to `Settings` (and to `SettingsUpdate` if the UI may set it).
//   2. Give it a default + validation in src/main/settings/schema.ts.
//   3. Show it in a section under src/renderer/src/components/settings/.

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

/** Interface size (zoom). 1 = 100%. */
export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type UiScale = (typeof UI_SCALES)[number];

/** Choices offered for the video folder size limit, in GB. */
export const CACHE_LIMIT_CHOICES_GB = [5, 10, 20, 50, 100] as const;

export interface Settings {
  /** "system" follows the OS light/dark mode. */
  theme: Theme;
  uiScale: UiScale;
  /** Folder where videos are kept while watching. null = the default folder. */
  cacheDir: string | null;
  /** Most the video folder may hold, in GB. null = no limit. */
  cacheLimitGb: number | null;
  /** Use the GPU for drawing and video. Takes effect after a restart. */
  hardwareAcceleration: boolean;
}

/**
 * What the UI may change directly. The video folder isn't here on purpose:
 * it only changes through the folder picker in the main process, so a page
 * can never point Streamy at an arbitrary folder.
 */
export type SettingsUpdate = Partial<Omit<Settings, "cacheDir">>;

/** Settings plus the facts the UI needs to show them. */
export interface SettingsSnapshot {
  settings: Settings;
  /** Where videos go when `settings.cacheDir` is null. */
  defaultCacheDir: string;
  /** Whether this run of Streamy uses the GPU (changes only on restart). */
  hardwareAccelerationActive: boolean;
}

export type ChooseCacheDirResult =
  | { status: "changed" }
  | { status: "canceled" }
  | { status: "error"; message: string };

/** How much space Streamy's videos take, or why it can't tell. */
export type CacheUsage =
  | { status: "ok"; bytes: number }
  /** The chosen folder isn't there (e.g. an external drive is unplugged). */
  | { status: "missing" };

/** Result of an action that can fail for a reason worth showing the user. */
export type ActionResult =
  { status: "ok" } | { status: "error"; message: string };

/**
 * Settings that live in the operating system rather than in settings.json.
 * `available: false` means this build can't change them (e.g. a dev build,
 * which would register Electron itself instead of Streamy).
 */
export interface SystemIntegration {
  available: boolean;
  openAtLogin: boolean;
  /** macOS: the user still has to allow it in System Settings. */
  openAtLoginNeedsApproval: boolean;
  /** Streamy is the app that opens magnet: links. */
  handlesMagnetLinks: boolean;
}

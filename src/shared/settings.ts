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

/** Subtitle look in the player. */
export const SUBTITLE_SIZES = ["s", "m", "l", "xl"] as const;
export type SubtitleSize = (typeof SUBTITLE_SIZES)[number];
export const SUBTITLE_BACKGROUNDS = ["none", "shadow", "box"] as const;
export type SubtitleBackground = (typeof SUBTITLE_BACKGROUNDS)[number];
export const SUBTITLE_COLORS = ["white", "yellow"] as const;
export type SubtitleColor = (typeof SUBTITLE_COLORS)[number];

/** "off" = transcoding always uses the CPU (libx264). */
export const HARDWARE_ENCODING_MODES = ["auto", "off"] as const;
export type HardwareEncoding = (typeof HARDWARE_ENCODING_MODES)[number];

/**
 * What a language setting may hold: a code like "en" or "pt-BR", or a file's
 * own tag like "tlh". Main validates with it; the player checks before saving.
 */
export const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

/** `subtitleLanguage` value for "never show subtitles". */
export const SUBTITLES_OFF = "off";

/**
 * Choices offered for download/upload limits, in KB/s. 1 KB = 1000 bytes,
 * like every size and speed Streamy shows.
 */
export const RATE_LIMIT_CHOICES_KBPS = [
  250, 500, 1000, 2000, 5000, 10000, 20000, 50000,
] as const;

/** Choices for keepSharingMinutes. null = until Streamy quits. */
export const KEEP_SHARING_CHOICES_MINUTES = [0, 10, 60, null] as const;

/** Choices for maxConnections. */
export const MAX_CONNECTION_CHOICES = [25, 50, 100, 200] as const;

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
  /**
   * Look for new versions on GitHub at start and every few hours. Off =
   * Streamy contacts nothing but torrent peers (checking by hand still works).
   */
  checkForUpdates: boolean;

  // Playback
  /**
   * Audio language to pick when a file has several (ISO 639-1, e.g. "en").
   * null = Automatic: the file's default track. Picking a track in the
   * player updates it.
   */
  audioLanguage: string | null;
  /**
   * Subtitle language to show (ISO 639-1). SUBTITLES_OFF = never.
   * null = Automatic: the file's default/forced track, if any. Picking
   * subtitles in the player updates it.
   */
  subtitleLanguage: string | null;
  subtitleSize: SubtitleSize;
  subtitleBackground: SubtitleBackground;
  subtitleColor: SubtitleColor;
  /** Lets transcoding use the GPU's video encoder. */
  hardwareEncoding: HardwareEncoding;

  // Network
  /** KB/s (1000 bytes). null = unlimited. */
  downloadLimitKBps: number | null;
  /** KB/s (1000 bytes). null = unlimited. */
  uploadLimitKBps: number | null;
  /**
   * Minutes a torrent keeps downloading and sharing after you stop watching
   * it. 0 = stop soon after (about a minute, so a reload doesn't stop it).
   * null = until Streamy quits.
   */
  keepSharingMinutes: number | null;
  /** Peer connections per torrent. */
  maxConnections: number;
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
  /**
   * The video folder used before the last change, while this run of Streamy
   * lasts. Videos aren't moved, so Settings says they stayed there (and can
   * show that folder). null = no change since Streamy started.
   */
  previousCacheDir: string | null;
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
  /**
   * This copy can become the magnet app. false for the Linux AppImage: that
   * needs a streamy.desktop in the system's app list, which only the .deb
   * installs.
   */
  canHandleMagnetLinks: boolean;
}

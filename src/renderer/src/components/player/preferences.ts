import type { SubtitleTrack } from "../../../../shared/engine-api";
import {
  LANGUAGE_TAG_PATTERN,
  type Settings,
  type SettingsSnapshot,
  type SettingsUpdate,
  SUBTITLES_OFF,
} from "../../../../shared/settings";
import { isRecord, readJson, writeJson } from "@/lib/storage";

// Where the player's preferences live:
// - Settings (the main process, every window): audio and subtitle language,
//   subtitle look. Picking in the player updates them, like Settings does.
// - localStorage (this window, a convenience): volume, mute, subtitle delay.
// - The library (the engine): where you are in each file, and the tracks
//   chosen for it (restored when resuming).

/** Per-window conveniences, kept in localStorage. */
export type LocalPrefs = {
  /** 0..1 */
  volume: number;
  muted: boolean;
  /** Seconds; positive = subtitles later. */
  subtitleDelay: number;
};

export const DEFAULT_LOCAL_PREFS: LocalPrefs = {
  volume: 1,
  muted: false,
  subtitleDelay: 0,
};

const PREFS_KEY = "streamy-player";

/** Whatever is stored, complete and valid prefs come back. */
export function readLocalPrefs(): LocalPrefs {
  const stored = readJson(PREFS_KEY);
  if (!isRecord(stored)) return DEFAULT_LOCAL_PREFS;
  const number = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    volume: Math.min(1, Math.max(0, number(stored.volume, 1))),
    muted: stored.muted === true,
    subtitleDelay: number(stored.subtitleDelay, 0),
  };
}

export function writeLocalPrefs(prefs: LocalPrefs): void {
  writeJson(PREFS_KEY, prefs);
}

/** The settings the player reads. */
export type PlaybackSettings = Pick<
  Settings,
  | "audioLanguage"
  | "subtitleLanguage"
  | "subtitleSize"
  | "subtitleBackground"
  | "subtitleColor"
>;

/**
 * The defaults the main process uses (src/main/settings/schema.ts), for
 * the moment before the settings have loaded.
 */
export const DEFAULT_PLAYBACK_SETTINGS: PlaybackSettings = {
  audioLanguage: null,
  subtitleLanguage: null,
  subtitleSize: "m",
  subtitleBackground: "shadow",
  subtitleColor: "white",
};

export function playbackSettings(
  snapshot: SettingsSnapshot | null,
): PlaybackSettings {
  if (!snapshot) return DEFAULT_PLAYBACK_SETTINGS;
  const { settings } = snapshot;
  return {
    audioLanguage: settings.audioLanguage,
    subtitleLanguage: settings.subtitleLanguage,
    subtitleSize: settings.subtitleSize,
    subtitleBackground: settings.subtitleBackground,
    subtitleColor: settings.subtitleColor,
  };
}

/**
 * A track's language as Settings can store it, or null. The engine keeps
 * tags it doesn't know as they are in the file: "zh_TW" becomes "zh-TW",
 * and "Português" can't be stored (matching tracks to it later compares
 * the base language, so "zh-TW" still finds "zh_TW").
 */
export function storableLanguage(language: string | null): string | null {
  if (!language) return null;
  const tag = language.trim().replaceAll("_", "-");
  return LANGUAGE_TAG_PATTERN.test(tag) ? tag : null;
}

/**
 * What picking subtitles in the player remembers for next time: their
 * language, or "off". A track without a usable language says nothing about
 * what the viewer wants, so it changes nothing.
 */
export function subtitlePreferenceUpdate(
  track: SubtitleTrack | null,
): SettingsUpdate | null {
  if (!track) return { subtitleLanguage: SUBTITLES_OFF };
  const language = storableLanguage(track.language);
  return language ? { subtitleLanguage: language } : null;
}

/** What picking an audio track remembers: its language, if it has one. */
export function audioPreferenceUpdate(
  language: string | null,
): SettingsUpdate | null {
  const storable = storableLanguage(language);
  return storable ? { audioLanguage: storable } : null;
}

import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  HARDWARE_ENCODING_MODES,
  LANGUAGE_TAG_PATTERN,
  type Settings,
  type SettingsUpdate,
  SUBTITLE_BACKGROUNDS,
  SUBTITLE_COLORS,
  SUBTITLE_SIZES,
  THEMES,
  UI_SCALES,
} from "../../shared/settings";

/** Bump this when the saved format changes, and add a migration below. */
export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: "system",
  uiScale: 1,
  cacheDir: null,
  cacheLimitGb: 20,
  hardwareAcceleration: true,
  checkForUpdates: true,
  audioLanguage: null,
  subtitleLanguage: null,
  subtitleSize: "m",
  subtitleBackground: "shadow",
  subtitleColor: "white",
  hardwareEncoding: "auto",
  downloadLimitKBps: null,
  uploadLimitKBps: null,
  keepSharingMinutes: 10,
  maxConnections: 100,
});

/** A language code like "en", "pt-BR", or a file's raw tag like "tlh". */
const language = z
  .string()
  .regex(LANGUAGE_TAG_PATTERN, "Must be a language code")
  .nullable();

/** KB/s; null = unlimited. Up to ~10 GB/s. */
const rateLimit = z.number().int().min(1).max(10_000_000).nullable();

const fields = {
  theme: z.enum(THEMES),
  uiScale: z.literal(UI_SCALES),
  cacheDir: z
    .string()
    .refine((path) => isAbsolute(path), "Must be an absolute path")
    .nullable(),
  cacheLimitGb: z.number().int().min(1).max(100_000).nullable(),
  hardwareAcceleration: z.boolean(),
  checkForUpdates: z.boolean(),
  audioLanguage: language,
  subtitleLanguage: language,
  subtitleSize: z.enum(SUBTITLE_SIZES),
  subtitleBackground: z.enum(SUBTITLE_BACKGROUNDS),
  subtitleColor: z.enum(SUBTITLE_COLORS),
  hardwareEncoding: z.enum(HARDWARE_ENCODING_MODES),
  downloadLimitKBps: rateLimit,
  uploadLimitKBps: rateLimit,
  // Up to a week; null = until Streamy quits.
  keepSharingMinutes: z.number().int().min(0).max(10_080).nullable(),
  maxConnections: z.number().int().min(1).max(1000),
};

/** Exact values. Used when the app changes a setting: anything wrong throws. */
export const settingsSchema = z.strictObject(
  fields,
) satisfies z.ZodType<Settings>;

/** The schema of each setting, by name. */
export const fieldSchemas: Readonly<Record<string, z.ZodType>> = fields;

/**
 * Used when reading settings.json. A missing or bad value falls back to its
 * default on its own, so one problem (a hand-edited file, a value from a newer
 * Streamy) never resets all the other settings.
 */
export const savedSettingsSchema = z.object({
  theme: fields.theme.catch(DEFAULT_SETTINGS.theme),
  uiScale: fields.uiScale.catch(DEFAULT_SETTINGS.uiScale),
  cacheDir: fields.cacheDir.catch(DEFAULT_SETTINGS.cacheDir),
  cacheLimitGb: fields.cacheLimitGb.catch(DEFAULT_SETTINGS.cacheLimitGb),
  hardwareAcceleration: fields.hardwareAcceleration.catch(
    DEFAULT_SETTINGS.hardwareAcceleration,
  ),
  checkForUpdates: fields.checkForUpdates.catch(
    DEFAULT_SETTINGS.checkForUpdates,
  ),
  audioLanguage: fields.audioLanguage.catch(DEFAULT_SETTINGS.audioLanguage),
  subtitleLanguage: fields.subtitleLanguage.catch(
    DEFAULT_SETTINGS.subtitleLanguage,
  ),
  subtitleSize: fields.subtitleSize.catch(DEFAULT_SETTINGS.subtitleSize),
  subtitleBackground: fields.subtitleBackground.catch(
    DEFAULT_SETTINGS.subtitleBackground,
  ),
  subtitleColor: fields.subtitleColor.catch(DEFAULT_SETTINGS.subtitleColor),
  hardwareEncoding: fields.hardwareEncoding.catch(
    DEFAULT_SETTINGS.hardwareEncoding,
  ),
  downloadLimitKBps: fields.downloadLimitKBps.catch(
    DEFAULT_SETTINGS.downloadLimitKBps,
  ),
  uploadLimitKBps: fields.uploadLimitKBps.catch(
    DEFAULT_SETTINGS.uploadLimitKBps,
  ),
  keepSharingMinutes: fields.keepSharingMinutes.catch(
    DEFAULT_SETTINGS.keepSharingMinutes,
  ),
  maxConnections: fields.maxConnections.catch(DEFAULT_SETTINGS.maxConnections),
}) satisfies z.ZodType<Settings>;

/** What the UI is allowed to send (see SettingsUpdate). */
export const settingsUpdateSchema = z
  .strictObject({
    theme: fields.theme,
    uiScale: fields.uiScale,
    cacheLimitGb: fields.cacheLimitGb,
    hardwareAcceleration: fields.hardwareAcceleration,
    checkForUpdates: fields.checkForUpdates,
    audioLanguage: fields.audioLanguage,
    subtitleLanguage: fields.subtitleLanguage,
    subtitleSize: fields.subtitleSize,
    subtitleBackground: fields.subtitleBackground,
    subtitleColor: fields.subtitleColor,
    hardwareEncoding: fields.hardwareEncoding,
    downloadLimitKBps: fields.downloadLimitKBps,
    uploadLimitKBps: fields.uploadLimitKBps,
    keepSharingMinutes: fields.keepSharingMinutes,
    maxConnections: fields.maxConnections,
  })
  .partial() satisfies z.ZodType<SettingsUpdate>;

export type Migration = (
  data: Record<string, unknown>,
) => Record<string, unknown>;

/**
 * MIGRATIONS[n] turns a version-n file into version n + 1. Example for a
 * future version 2 that renames a key:
 *   1: ({ oldName, ...rest }) => ({ ...rest, newName: oldName }),
 */
export const MIGRATIONS: Readonly<Partial<Record<number, Migration>>> = {};

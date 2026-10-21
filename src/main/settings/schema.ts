import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  type Settings,
  type SettingsUpdate,
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
});

const fields = {
  theme: z.enum(THEMES),
  uiScale: z.literal(UI_SCALES),
  cacheDir: z
    .string()
    .refine((path) => isAbsolute(path), "Must be an absolute path")
    .nullable(),
  cacheLimitGb: z.number().int().min(1).max(100_000).nullable(),
  hardwareAcceleration: z.boolean(),
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
}) satisfies z.ZodType<Settings>;

/** What the UI is allowed to send (see SettingsUpdate). */
export const settingsUpdateSchema = z
  .strictObject({
    theme: fields.theme,
    uiScale: fields.uiScale,
    cacheLimitGb: fields.cacheLimitGb,
    hardwareAcceleration: fields.hardwareAcceleration,
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

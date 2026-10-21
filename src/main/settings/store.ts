import type { Settings } from "../../shared/settings";
import {
  type ReadResult,
  readJsonFile,
  writeJsonFile,
} from "../storage/json-file";
import {
  DEFAULT_SETTINGS,
  fieldSchemas,
  MIGRATIONS,
  type Migration,
  SETTINGS_VERSION,
  savedSettingsSchema,
  settingsSchema,
} from "./schema";

type Listener = (settings: Readonly<Settings>) => void;

export interface ParsedSettings {
  settings: Settings;
  /**
   * Things in the file this version can't use, kept so saving doesn't erase
   * them: unknown keys, and values it can't read (both usually written by a
   * newer Streamy, e.g. a theme this version doesn't have).
   */
  keep: Record<string, unknown>;
  version: number;
}

interface ParseOptions {
  migrations?: Readonly<Partial<Record<number, Migration>>>;
  currentVersion?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns whatever is in settings.json into valid settings (never throws). */
export function parseSettingsFile(
  raw: unknown,
  {
    migrations = MIGRATIONS,
    currentVersion = SETTINGS_VERSION,
  }: ParseOptions = {},
): ParsedSettings {
  if (!isRecord(raw)) {
    return {
      settings: { ...DEFAULT_SETTINGS },
      keep: {},
      version: currentVersion,
    };
  }

  const fileVersion = raw.version;
  let version =
    typeof fileVersion === "number" &&
    Number.isInteger(fileVersion) &&
    fileVersion >= 1
      ? fileVersion
      : 1;
  let data = raw;
  for (; version < currentVersion; version++) {
    const migrate = migrations[version];
    if (migrate) data = migrate(data);
  }

  const settings = savedSettingsSchema.parse(data);
  const keep = Object.fromEntries(
    Object.entries(data).filter(([key, value]) => {
      if (key === "version") return false;
      const schema = Object.hasOwn(fieldSchemas, key)
        ? fieldSchemas[key]
        : undefined;
      return !schema?.safeParse(value).success;
    }),
  );
  // A file from a newer Streamy keeps its version number, so that version
  // doesn't re-run its migrations on data that's already up to date.
  return { settings, keep, version };
}

/**
 * The user's settings, kept in one JSON file. Only the main process reads or
 * writes it; the UI asks through IPC (see ./index.ts).
 */
export class SettingsStore {
  readonly #file: string;
  readonly #listeners = new Set<Listener>();
  #settings: Readonly<Settings> = DEFAULT_SETTINGS;
  #keep: Record<string, unknown> = {};
  #version = SETTINGS_VERSION;
  /** False while settings.json exists but can't be read: never overwrite it. */
  #canSave = true;

  constructor(file: string) {
    this.#file = file;
    this.#load(readJsonFile(file));
  }

  #load(result: ReadResult): void {
    this.#canSave = result.status !== "unreadable";
    const parsed = parseSettingsFile(
      result.status === "ok" ? result.data : undefined,
    );
    this.#settings = Object.freeze(parsed.settings);
    this.#keep = parsed.keep;
    this.#version = parsed.version;
  }

  get(): Readonly<Settings> {
    return this.#settings;
  }

  /**
   * Validates, saves to disk, then tells listeners. Throws (and changes
   * nothing) if a value is invalid or the file can't be written.
   */
  update(patch: Partial<Settings>): Readonly<Settings> {
    if (!this.#canSave) {
      // The file couldn't be read at startup (e.g. it was locked). Try again
      // rather than replace settings we never saw.
      const again = readJsonFile(this.#file);
      this.#load(again);
      if (again.status === "unreadable") {
        throw new Error("settings.json can't be read, so it wasn't changed");
      }
    }

    // `{ theme: undefined }` means "no change", not "erase the theme".
    const changes = Object.fromEntries(
      Object.entries(patch).filter(
        ([, value]: [string, unknown]) => value !== undefined,
      ),
    );
    const next = settingsSchema.parse({ ...this.#settings, ...changes });
    if (JSON.stringify(next) === JSON.stringify(this.#settings)) {
      return this.#settings;
    }

    // A value set now replaces whatever unreadable value was kept for it.
    const keep = Object.fromEntries(
      Object.entries(this.#keep).filter(
        ([key]) => !Object.hasOwn(changes, key),
      ),
    );
    writeJsonFile(this.#file, { ...next, ...keep, version: this.#version });
    this.#keep = keep;
    this.#settings = Object.freeze(next);
    for (const listener of this.#listeners) listener(this.#settings);
    return this.#settings;
  }

  /** Every setting back to its default. */
  reset(): Readonly<Settings> {
    return this.update({ ...DEFAULT_SETTINGS });
  }

  /** Calls `listener` after every change. Returns an unsubscribe function. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/**
 * localStorage that never throws. Storage can be blocked or hold something
 * an older version wrote; neither should break the page, so reads fall back
 * and writes are best effort. Only for per-window conveniences: settings
 * live in the main process (lib/settings.ts).
 */
export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not saved, which only costs a convenience.
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

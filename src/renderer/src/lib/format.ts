const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

/**
 * The language every number and date is written in. Streamy's text is
 * English only for now, so the OS language would mix in ("Opened vor 5
 * Minuten", "1,2 MB" in an English sentence). Tests can pass another one.
 */
export const UI_LOCALE = "en";

/** 1234567 → "1.2 MB" (1 kB = 1000 bytes, like macOS and drive makers). */
export function formatBytes(bytes: number, locale = UI_LOCALE): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: UNITS[unit],
    // "0 bytes" rather than the short form's "0 byte"; "1.2 MB" for the rest.
    unitDisplay: unit === 0 ? "long" : "short",
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  }).format(value);
}

/**
 * Bytes per second → "1.4 MB/s". Starts at kB/s ("0 kB/s", "0.5 kB/s"):
 * "byte/s" reads oddly and nobody cares about single bytes of speed.
 */
export function formatSpeed(
  bytesPerSecond: number,
  locale = UI_LOCALE,
): string {
  let value =
    Number.isFinite(bytesPerSecond) && bytesPerSecond > 0
      ? bytesPerSecond / 1000
      : 0;
  let unit = 1;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: `${UNITS[unit] ?? "kilobyte"}-per-second`,
    unitDisplay: "short",
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

/**
 * A rate limit from Settings (KB/s, 1 KB = 1000 bytes) → "500 kB/s",
 * "1 MB/s", "2.5 MB/s". Written like a speed, so a "10 MB/s" limit and a
 * torrent going at 10 MB/s look the same.
 */
export function formatRateLimit(
  kilobytesPerSecond: number,
  locale = UI_LOCALE,
): string {
  return formatSpeed(kilobytesPerSecond * 1000, locale);
}

/** 75 → "1:15", 4330 → "1:12:10". Negative or unknown → "0:00". */
export function formatTime(seconds: number): string {
  const total =
    Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** 0.4567 → "45%" (rounded down: never "100%" before it is). */
export function formatPercent(fraction: number): string {
  const clamped = Math.min(1, Math.max(0, fraction || 0));
  return `${Math.floor(clamped * 100)}%`;
}

/** Seconds → "12 s", "3 min 05 s" (how long we've been waiting). */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m} min ${s} s`;
}

/** What's left of a video: "12 min left", "1 h 5 min left". */
export function formatTimeLeft(seconds: number): string {
  const minutes = Number.isFinite(seconds)
    ? Math.round(Math.max(0, seconds) / 60)
    : 0;
  if (minutes < 1) return "Less than a minute left";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min left`;
  if (m === 0) return `${h} h left`;
  return `${h} h ${m} min left`;
}

/** 0.3 → "+0.3 s", -1 → "−1.0 s", 0 → "0.0 s" (subtitle delay). */
export function formatDelay(seconds: number): string {
  const rounded = Math.round(seconds * 10) / 10;
  if (rounded === 0) return "0.0 s";
  const sign = rounded > 0 ? "+" : "−";
  return `${sign}${Math.abs(rounded).toFixed(1)} s`;
}

/** 1 → "1 peer", 12 → "12 peers". */
export function formatPeers(peers: number): string {
  return `${peers} ${peers === 1 ? "peer" : "peers"}`;
}

/** "12 peers · 1.4 MB/s": how a torrent is doing right now. */
export function formatSwarm(torrent: {
  peers: number;
  downloadSpeed: number;
}): string {
  return `${formatPeers(torrent.peers)} · ${formatSpeed(torrent.downloadSpeed)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * When something happened, roughly: "just now", "5 minutes ago",
 * "yesterday", "3 days ago", then the date ("Oct 12", "Oct 12, 2025").
 * Unknown dates → null.
 */
export function formatRelativeTime(
  iso: string,
  now = Date.now(),
  locale = UI_LOCALE,
): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  const ago = Math.max(0, now - time);
  if (ago < MINUTE) return "just now";

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (ago < HOUR) return relative.format(-Math.floor(ago / MINUTE), "minute");
  if (ago < DAY) return relative.format(-Math.floor(ago / HOUR), "hour");
  if (ago < 7 * DAY) return relative.format(-Math.floor(ago / DAY), "day");

  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  }).format(date);
}

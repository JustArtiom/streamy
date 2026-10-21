const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

/**
 * 1234567 → "1.2 MB" (1 kB = 1000 bytes, like macOS and drive makers).
 * Uses the user's language for the number format unless `locale` is given.
 */
export function formatBytes(bytes: number, locale?: string): string {
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

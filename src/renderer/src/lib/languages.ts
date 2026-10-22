import { UI_LOCALE } from "@/lib/format";

// Language names for language codes, in the interface's language (English
// for now, like every other text), using the browser's built-in
// Intl.DisplayNames (no translation tables to maintain). The engine reports
// tracks as ISO 639-1 ("en") when it can tell.

/**
 * Languages offered in Settings → Playback: the ones the engine recognises
 * in files (src/engine media languages). A sensible list, not every ISO code.
 */
export const COMMON_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ru", "ja", "zh", "ko", "ar", "hi",
  "pl", "nl", "sv", "no", "da", "fi", "tr", "uk", "cs", "hu", "ro", "el",
  "he", "th", "vi", "id", "ms", "fa", "bg", "hr", "sr", "sk", "sl", "et",
  "lv", "lt", "is", "ga", "cy", "eu", "ca", "gl", "sq", "mk", "bs", "hy",
  "ka", "az", "kk", "uz", "be", "bn", "ta", "te", "ml", "ur", "tl", "sw",
  "af", "mn",
] as const; // prettier-ignore

// One DisplayNames per locale; building it isn't free and names are looked
// up on every render of a language list.
const cache = new Map<string, Intl.DisplayNames | null>();

function displayNames(locale: string) {
  if (!cache.has(locale)) {
    try {
      cache.set(locale, new Intl.DisplayNames([locale], { type: "language" }));
    } catch {
      cache.set(locale, null);
    }
  }
  return cache.get(locale) ?? null;
}

/**
 * The viewer's own language, e.g. "de-DE": a good guess for which audio or
 * subtitles they want. (Names are still written in English: UI_LOCALE.)
 */
export function defaultLocale(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language || "en";
}

/**
 * "en" → "English", "pt-BR" → "Brazilian Portuguese", null → "Unknown".
 * Codes the browser can't name (or that aren't valid) come back as they are.
 */
export function languageName(code: string | null, locale = UI_LOCALE): string {
  if (!code) return "Unknown";
  try {
    const name = displayNames(locale)?.of(code);
    // Unknown codes come back unchanged: show them as they are ("qaa").
    if (!name || name.toLowerCase() === code.toLowerCase()) return code;
    // Some locales write language names in lowercase ("anglais").
    return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // RangeError for codes that aren't valid BCP 47 ("english", "x")
    return code;
  }
}

/** "pt-BR" → "pt", "EN" → "en": compare languages, not regional variants. */
export function baseLanguage(code: string | null): string | null {
  if (!code) return null;
  return code.toLowerCase().split(/[-_]/)[0] ?? null;
}

export function sameLanguage(a: string | null, b: string | null): boolean {
  const left = baseLanguage(a);
  return left !== null && left === baseLanguage(b);
}

/**
 * Codes with their names, sorted by name, for a picker. `extra` adds codes
 * that aren't in the list (e.g. one picked in the player) so the current
 * choice always shows up.
 */
export function languageOptions(
  extra: (string | null)[] = [],
  locale = UI_LOCALE,
): { code: string; name: string }[] {
  const codes = new Set<string>(COMMON_LANGUAGES);
  for (const code of extra) if (code) codes.add(code);
  const collator = new Intl.Collator(locale);
  return [...codes]
    .map((code) => ({ code, name: languageName(code, locale) }))
    .sort((a, b) => collator.compare(a.name, b.name));
}

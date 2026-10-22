/*
 * Language tags → ISO 639-1 ("en"), so the frontend can name them and match
 * the viewer's preference whatever the file used: "eng" (639-2/B), "deu"
 * (639-2/T), "English", "pt-BR"…
 */

// [639-1, other spellings…]: 639-2/B, 639-2/T, English and native names.
const LANGUAGES: [string, ...string[]][] = [
  ["en", "eng", "english"],
  ["ru", "rus", "russian", "русский"],
  ["fr", "fre", "fra", "french", "français", "francais"],
  ["de", "ger", "deu", "german", "deutsch"],
  ["es", "spa", "esp", "spanish", "español", "espanol", "castilian"],
  ["pt", "por", "pob", "portuguese", "português", "portugues", "brazilian"],
  ["it", "ita", "italian", "italiano"],
  ["ja", "jpn", "jap", "japanese", "日本語"],
  ["zh", "chi", "zho", "chinese", "mandarin", "cantonese", "中文"],
  ["ko", "kor", "korean", "한국어"],
  ["ar", "ara", "arabic"],
  ["hi", "hin", "hindi"],
  ["pl", "pol", "polish", "polski"],
  ["nl", "dut", "nld", "dutch", "flemish", "nederlands"],
  ["sv", "swe", "swedish", "svenska"],
  ["no", "nor", "nob", "nno", "norwegian", "norsk"],
  ["da", "dan", "danish", "dansk"],
  ["fi", "fin", "finnish", "suomi"],
  ["tr", "tur", "turkish", "türkçe", "turkce"],
  ["uk", "ukr", "ukrainian", "українська"],
  ["cs", "cze", "ces", "czech", "čeština", "cestina"],
  ["hu", "hun", "hungarian", "magyar"],
  ["ro", "rum", "ron", "romanian", "română", "romana"],
  ["el", "gre", "ell", "greek"],
  ["he", "heb", "hebrew"],
  ["th", "tha", "thai"],
  ["vi", "vie", "vietnamese"],
  ["id", "ind", "indonesian"],
  ["ms", "may", "msa", "malay"],
  ["fa", "per", "fas", "persian", "farsi"],
  ["bg", "bul", "bulgarian"],
  ["hr", "hrv", "croatian", "hrvatski"],
  ["sr", "srp", "serbian", "srpski"],
  ["sk", "slo", "slk", "slovak"],
  ["sl", "slv", "slovenian", "slovene"],
  ["et", "est", "estonian"],
  ["lv", "lav", "latvian"],
  ["lt", "lit", "lithuanian"],
  ["is", "ice", "isl", "icelandic"],
  ["ga", "gle", "irish"],
  ["cy", "wel", "cym", "welsh"],
  ["eu", "baq", "eus", "basque"],
  ["ca", "cat", "catalan"],
  ["gl", "glg", "galician"],
  ["sq", "alb", "sqi", "albanian"],
  ["mk", "mac", "mkd", "macedonian"],
  ["bs", "bos", "bosnian"],
  ["hy", "arm", "hye", "armenian"],
  ["ka", "geo", "kat", "georgian"],
  ["az", "aze", "azerbaijani"],
  ["kk", "kaz", "kazakh"],
  ["uz", "uzb", "uzbek"],
  ["be", "bel", "belarusian"],
  ["bn", "ben", "bengali"],
  ["ta", "tam", "tamil"],
  ["te", "tel", "telugu"],
  ["ml", "mal", "malayalam"],
  ["ur", "urd", "urdu"],
  ["tl", "tgl", "fil", "tagalog", "filipino"],
  ["sw", "swa", "swahili"],
  ["af", "afr", "afrikaans"],
  ["mn", "mon", "mongolian"],
];

/** Any known spelling (lower case) → 639-1. */
const BY_NAME = new Map<string, string>(
  LANGUAGES.flatMap(([code, ...names]) =>
    [code, ...names].map((name) => [name, code] as const),
  ),
);

/** Tags that mean "no language" in ffprobe output and file names. */
const NO_LANGUAGE = new Set(["", "und", "unk", "unknown", "zxx", "mis", "mul"]);

/** A known language for `word` ("eng", "English", "pt-BR"), or null. */
export function knownLanguage(word: string): string | null {
  const lower = word.trim().toLowerCase();
  return (
    BY_NAME.get(lower) ??
    // BCP 47 like "pt-BR" or "zh_Hans": the first part is the language.
    BY_NAME.get(lower.split(/[-_]/)[0] ?? "") ??
    null
  );
}

/**
 * A stream's language tag → 639-1 when we know it, else the raw tag
 * ("tlh"), else null ("und", missing).
 */
export function normalizeLanguage(
  tag: string | null | undefined,
): string | null {
  const trimmed = tag?.trim() ?? "";
  if (NO_LANGUAGE.has(trimmed.toLowerCase())) return null;
  return knownLanguage(trimmed) ?? trimmed;
}

// "HI" in subtitle names nearly always means "hearing impaired", not Hindi.
const AMBIGUOUS = new Set(["hi"]);

/**
 * The language of a subtitle file from its name: "Sintel.en.srt",
 * "English.srt", "2_Eng.srt", "movie.pt-BR.srt", "Movie.en.forced.srt".
 * Looks at the words from the end (the language is usually last), and
 * ignores the video's own name in front, so "It.2017.srt" isn't Italian.
 */
export function languageFromFileName(
  fileName: string,
  videoBaseName?: string,
): string | null {
  let base = fileName.replace(/\.[^.]+$/, "");
  if (videoBaseName && startsWithName(base, videoBaseName)) {
    base = base.slice(videoBaseName.length);
  }

  // Only the last few words: titles are full of short words that happen to
  // be language codes ("It", "No", "Is").
  const words = base
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(-3);
  let fallback: string | null = null;
  for (const word of words.reverse()) {
    const code = knownLanguage(word);
    if (!code) continue;
    if (!AMBIGUOUS.has(word.toLowerCase())) return code;
    fallback ??= code;
  }
  return fallback;
}

/** "Movie.en" starts with the name "Movie"; "Movie 2.en" doesn't. */
export function startsWithName(text: string, name: string): boolean {
  if (!name || !text.toLowerCase().startsWith(name.toLowerCase())) {
    return false;
  }
  const next = text.charAt(name.length);
  return next === "" || !/[\p{L}\p{N}]/u.test(next);
}

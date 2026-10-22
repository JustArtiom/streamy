import { describe, expect, it, vi } from "vitest";
import {
  baseLanguage,
  defaultLocale,
  languageName,
  languageOptions,
  sameLanguage,
} from "@/lib/languages";

describe("languageName", () => {
  it("names languages in the viewer's language", () => {
    expect(languageName("en", "en")).toBe("English");
    expect(languageName("ru", "en")).toBe("Russian");
    expect(languageName("pt-BR", "en")).toBe("Brazilian Portuguese");
    expect(languageName("de", "de")).toBe("Deutsch");
  });

  it("capitalises names some locales write in lowercase", () => {
    expect(languageName("en", "fr")).toBe("Anglais");
  });

  it("says Unknown when there's no language", () => {
    expect(languageName(null, "en")).toBe("Unknown");
    expect(languageName("", "en")).toBe("Unknown");
  });

  it("falls back to the code it can't name", () => {
    expect(languageName("x", "en")).toBe("x");
    expect(languageName("qaa", "en")).toBe("qaa");
  });

  it("survives a broken locale", () => {
    expect(languageName("en", "not a locale!")).toBe("en");
  });

  // "Englisch (forced)" in an English menu mixes two languages.
  it("names them in English, like the rest of the interface", () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("de-DE");

    expect(languageName("en")).toBe("English");
    expect(languageOptions().map((option) => option.name)).toContain("German");
    // The viewer's language still says which tracks they probably want.
    expect(defaultLocale()).toBe("de-DE");
  });
});

describe("baseLanguage / sameLanguage", () => {
  it("compares languages, not regions or case", () => {
    expect(baseLanguage("pt-BR")).toBe("pt");
    expect(baseLanguage("EN")).toBe("en");
    expect(baseLanguage("zh_Hant")).toBe("zh");
    expect(baseLanguage(null)).toBeNull();
    expect(sameLanguage("pt-BR", "pt")).toBe(true);
    expect(sameLanguage("en", "EN")).toBe(true);
    expect(sameLanguage("en", "fr")).toBe(false);
  });

  it("never matches an unknown language", () => {
    expect(sameLanguage(null, null)).toBe(false);
    expect(sameLanguage(null, "en")).toBe(false);
  });
});

describe("languageOptions", () => {
  it("lists common languages by name", () => {
    const options = languageOptions([], "en");
    const names = options.map((option) => option.name);

    expect(options.length).toBeGreaterThan(40);
    expect(names).toContain("English");
    expect(names).toContain("Japanese");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("adds a language that isn't in the list, once", () => {
    const options = languageOptions(["tlh", "en", null], "en");

    expect(options.filter((option) => option.code === "tlh")).toHaveLength(1);
    expect(options.filter((option) => option.code === "en")).toHaveLength(1);
  });
});

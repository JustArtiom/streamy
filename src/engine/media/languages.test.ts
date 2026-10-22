import { describe, expect, it } from "vitest";
import {
  languageFromFileName,
  normalizeLanguage,
  startsWithName,
} from "./languages";

describe("normalizeLanguage", () => {
  it.each([
    ["eng", "en"],
    ["rus", "ru"],
    ["fre", "fr"],
    ["fra", "fr"],
    ["ger", "de"],
    ["deu", "de"],
    ["chi", "zh"],
    ["zho", "zh"],
    ["dut", "nl"],
    ["nld", "nl"],
    ["cze", "cs"],
    ["rum", "ro"],
    ["gre", "el"],
    ["en", "en"],
    ["EN", "en"],
    ["English", "en"],
    ["pt-BR", "pt"],
    ["zh_Hans", "zh"],
  ])("%s → %s", (tag, code) => {
    expect(normalizeLanguage(tag)).toBe(code);
  });

  it("returns null for und, empty and missing tags", () => {
    expect(normalizeLanguage("und")).toBeNull();
    expect(normalizeLanguage("")).toBeNull();
    expect(normalizeLanguage(undefined)).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
  });

  it("keeps an unknown tag as it is", () => {
    expect(normalizeLanguage("tlh")).toBe("tlh");
  });
});

describe("languageFromFileName", () => {
  it.each([
    ["Sintel.en.srt", "en"],
    ["Sintel_de.srt", "de"],
    ["English.srt", "en"],
    ["2_Eng.srt", "en"],
    ["movie.pt-BR.srt", "pt"],
    ["Movie.en.forced.srt", "en"],
    ["Movie.English.SDH.srt", "en"],
    ["Movie.en.HI.srt", "en"],
    ["Movie.2019.1080p.Russian.srt", "ru"],
    ["Español.srt", "es"],
    ["Movie.srt", null],
  ])("%s → %s", (name, code) => {
    expect(languageFromFileName(name)).toBe(code);
  });

  it("ignores the video's own name in front", () => {
    expect(languageFromFileName("It.srt", "It")).toBeNull();
    expect(languageFromFileName("It.ru.srt", "It")).toBe("ru");
  });

  it("only looks at the last words (titles are full of short words)", () => {
    expect(languageFromFileName("No.Country.For.Old.Men.2007.srt")).toBeNull();
  });

  it("treats a lone HI as Hindi", () => {
    expect(languageFromFileName("Movie.hi.srt", "Movie")).toBe("hi");
  });
});

describe("startsWithName", () => {
  it("needs a separator after the name", () => {
    expect(startsWithName("Movie.en", "Movie")).toBe(true);
    expect(startsWithName("movie", "Movie")).toBe(true);
    expect(startsWithName("Movie 2.en", "Movie")).toBe(true);
    expect(startsWithName("Movies.en", "Movie")).toBe(false);
    expect(startsWithName("Mov", "Movie")).toBe(false);
  });
});

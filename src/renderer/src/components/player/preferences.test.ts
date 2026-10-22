import { describe, expect, it } from "vitest";
import type { SubtitleTrack } from "../../../../shared/engine-api";
import { SUBTITLES_OFF } from "../../../../shared/settings";
import {
  audioPreferenceUpdate,
  DEFAULT_LOCAL_PREFS,
  DEFAULT_PLAYBACK_SETTINGS,
  playbackSettings,
  readLocalPrefs,
  storableLanguage,
  subtitlePreferenceUpdate,
  writeLocalPrefs,
} from "@/components/player/preferences";
import { INITIAL_SNAPSHOT } from "@/test/fake-streamy";

function sub(patch: Partial<SubtitleTrack>): SubtitleTrack {
  return {
    id: "file:1",
    source: "file",
    codec: "subrip",
    language: null,
    title: null,
    isDefault: false,
    isForced: false,
    isText: true,
    ...patch,
  };
}

describe("local player preferences", () => {
  it("starts from the defaults", () => {
    expect(readLocalPrefs()).toEqual(DEFAULT_LOCAL_PREFS);
  });

  it("round-trips what was saved", () => {
    const prefs = { volume: 0.4, muted: true, subtitleDelay: -0.3 };
    writeLocalPrefs(prefs);
    expect(readLocalPrefs()).toEqual(prefs);
  });

  it("repairs invalid values field by field", () => {
    localStorage.setItem(
      "streamy-player",
      JSON.stringify({ volume: 7, muted: "yes", subtitleDelay: "soon" }),
    );
    expect(readLocalPrefs()).toEqual({ ...DEFAULT_LOCAL_PREFS, volume: 1 });
  });

  it("ignores junk and what the prototype also stored there", () => {
    localStorage.setItem("streamy-player", "{not json");
    expect(readLocalPrefs()).toEqual(DEFAULT_LOCAL_PREFS);

    // Languages and subtitle style live in Settings now.
    localStorage.setItem(
      "streamy-player",
      JSON.stringify({ volume: 0.5, audioLanguage: "ja", subtitleStyle: {} }),
    );
    expect(readLocalPrefs()).toEqual({ ...DEFAULT_LOCAL_PREFS, volume: 0.5 });
  });
});

describe("settings-driven preferences", () => {
  it("reads the playback settings, with defaults before they load", () => {
    expect(playbackSettings(null)).toEqual(DEFAULT_PLAYBACK_SETTINGS);
    expect(
      playbackSettings({
        ...INITIAL_SNAPSHOT,
        settings: {
          ...INITIAL_SNAPSHOT.settings,
          audioLanguage: "ja",
          subtitleSize: "xl",
        },
      }),
    ).toEqual({
      ...DEFAULT_PLAYBACK_SETTINGS,
      audioLanguage: "ja",
      subtitleSize: "xl",
    });
  });

  it("remembers the subtitle language picked, or off", () => {
    expect(subtitlePreferenceUpdate(sub({ language: "fr" }))).toEqual({
      subtitleLanguage: "fr",
    });
    expect(subtitlePreferenceUpdate(null)).toEqual({
      subtitleLanguage: SUBTITLES_OFF,
    });
    // A track of unknown language says nothing about what's wanted.
    expect(subtitlePreferenceUpdate(sub({ language: null }))).toBeNull();
  });

  it("remembers the audio language picked", () => {
    expect(audioPreferenceUpdate("ja")).toEqual({ audioLanguage: "ja" });
    expect(audioPreferenceUpdate(null)).toBeNull();
  });

  it("stores unusual tags the way Settings accepts them, or not at all", () => {
    // The engine keeps tags it doesn't know as they are in the file.
    expect(subtitlePreferenceUpdate(sub({ language: "zh_TW" }))).toEqual({
      subtitleLanguage: "zh-TW",
    });
    expect(audioPreferenceUpdate("pt_BR")).toEqual({ audioLanguage: "pt-BR" });
    expect(audioPreferenceUpdate("tlh")).toEqual({ audioLanguage: "tlh" });
    // Settings would refuse these (quietly): nothing is saved instead.
    expect(subtitlePreferenceUpdate(sub({ language: "Português" }))).toBeNull();
    expect(audioPreferenceUpdate("English (US)")).toBeNull();
    expect(audioPreferenceUpdate("x")).toBeNull();
  });

  it("accepts exactly what the Settings schema accepts", () => {
    for (const tag of ["en", "pt-BR", "zh-Hant-TW", "sgn-BE-FR", "und"]) {
      expect(storableLanguage(tag)).toBe(tag);
    }
    for (const tag of ["", "e", "en-", "-en", "en--US", "123", "en US"]) {
      expect(storableLanguage(tag)).toBeNull();
    }
    expect(storableLanguage(" de ")).toBe("de");
  });
});

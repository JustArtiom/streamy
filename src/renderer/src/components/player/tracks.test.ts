import { describe, expect, it } from "vitest";
import type {
  AudioTrack,
  MediaInfo,
  SubtitleTrack,
} from "../../../../shared/engine-api";
import { SUBTITLES_OFF } from "../../../../shared/settings";
import {
  audioLabel,
  channelLayout,
  embeddedStreamIndex,
  initialSelection,
  pickAudio,
  pickSubtitle,
  qualityOptions,
  subtitleDetail,
  subtitleFileIndex,
  subtitleNeeds,
  subtitleToTurnOn,
} from "@/components/player/tracks";

function audio(patch: Partial<AudioTrack>): AudioTrack {
  return {
    index: 0,
    codec: "aac",
    channels: 2,
    language: null,
    title: null,
    isDefault: false,
    ...patch,
  };
}

function sub(patch: Partial<SubtitleTrack>): SubtitleTrack {
  return {
    id: "embedded:0",
    source: "embedded",
    codec: "subrip",
    language: null,
    title: null,
    isDefault: false,
    isForced: false,
    isText: true,
    ...patch,
  };
}

describe("pickAudio", () => {
  const tracks = [
    audio({ index: 0, language: "ru" }),
    audio({ index: 1, language: "en", isDefault: true }),
    audio({ index: 2, language: "de" }),
  ];

  it("prefers the language the viewer chose before", () => {
    expect(pickAudio(tracks, "de")?.index).toBe(2);
  });

  it("matches regional variants by base language", () => {
    expect(pickAudio(tracks, "de-AT")?.index).toBe(2);
  });

  it("falls back to the file's default track", () => {
    expect(pickAudio(tracks, "fr")?.index).toBe(1);
    expect(pickAudio(tracks, null)?.index).toBe(1);
  });

  it("falls back to the first track when none is default", () => {
    expect(
      pickAudio([audio({ index: 0 }), audio({ index: 1 })], null)?.index,
    ).toBe(0);
  });

  it("returns null without audio", () => {
    expect(pickAudio([], "en")).toBeNull();
  });
});

describe("subtitleToTurnOn", () => {
  // Like Sintel: one .srt per language, German first in the torrent.
  const german = sub({ id: "file:0", language: "de" });
  const english = sub({ id: "file:1", language: "en" });
  const spanish = sub({ id: "file:2", language: "es" });
  const tracks = [german, english, spanish];

  it("prefers the saved language", () => {
    expect(subtitleToTurnOn(tracks, ["es", "en-US", null])).toBe(spanish);
  });

  it("then the browser's language, not the first file", () => {
    expect(subtitleToTurnOn(tracks, [null, "en-US", "de"])).toBe(english);
  });

  it("then the audio's language", () => {
    expect(subtitleToTurnOn(tracks, [null, "fr-FR", "es"])).toBe(spanish);
  });

  it("else any text track", () => {
    const picture = sub({ id: "embedded:0", language: "it", isText: false });
    expect(subtitleToTurnOn([picture, german], [null, "fr", null])).toBe(
      german,
    );
  });

  it("returns null without subtitles", () => {
    expect(subtitleToTurnOn([], ["en"])).toBeNull();
  });
});

describe("pickSubtitle", () => {
  const englishPgs = sub({
    id: "embedded:0",
    language: "en",
    codec: "hdmv_pgs_subtitle",
    isText: false,
  });
  const englishForced = sub({
    id: "embedded:1",
    language: "en",
    isForced: true,
  });
  const englishText = sub({ id: "file:4", source: "file", language: "en" });
  const french = sub({ id: "embedded:2", language: "fr" });
  const tracks = [englishPgs, englishForced, englishText, french];

  it("shows nothing when the viewer turned subtitles off", () => {
    expect(pickSubtitle(tracks, SUBTITLES_OFF, "en")).toBeNull();
  });

  it("prefers full text subtitles in the preferred language", () => {
    expect(pickSubtitle(tracks, "en", "ru")?.id).toBe("file:4");
  });

  it("uses picture subtitles of the preferred language before forced ones", () => {
    expect(pickSubtitle([englishForced, englishPgs], "en", null)?.id).toBe(
      "embedded:0",
    );
  });

  it("uses a forced-only track when it's all there is in that language", () => {
    expect(pickSubtitle([englishForced, french], "en", null)?.id).toBe(
      "embedded:1",
    );
  });

  it("shows forced text subtitles in the audio's language by default", () => {
    expect(pickSubtitle(tracks, null, "en")?.id).toBe("embedded:1");
    expect(pickSubtitle(tracks, "es", "en")?.id).toBe("embedded:1");
  });

  it("never burns in a picture track unasked", () => {
    const forcedPgs = sub({
      id: "embedded:5",
      language: "en",
      isForced: true,
      isText: false,
    });
    expect(pickSubtitle([forcedPgs], null, "en")).toBeNull();
  });

  it("shows nothing when nothing fits", () => {
    expect(pickSubtitle(tracks, null, "ja")).toBeNull();
    expect(pickSubtitle([], "en", "en")).toBeNull();
  });
});

describe("subtitleNeeds", () => {
  const tracks = [
    sub({ id: "embedded:0", isText: false, codec: "hdmv_pgs_subtitle" }),
    sub({ id: "embedded:1" }),
    sub({ id: "file:3", source: "file" }),
  ];

  it("burns in picture subtitles", () => {
    expect(subtitleNeeds(tracks, "embedded:0")).toEqual({
      burnSubtitle: "embedded:0",
      embeddedSubtitles: false,
    });
  });

  it("asks ffmpeg for embedded text cues", () => {
    expect(subtitleNeeds(tracks, "embedded:1")).toEqual({
      burnSubtitle: null,
      embeddedSubtitles: true,
    });
  });

  it("needs nothing from the server for files or off", () => {
    const none = { burnSubtitle: null, embeddedSubtitles: false };
    expect(subtitleNeeds(tracks, "file:3")).toEqual(none);
    expect(subtitleNeeds(tracks, null)).toEqual(none);
  });
});

describe("track ids", () => {
  it("reads the stream or file index out of an id", () => {
    expect(embeddedStreamIndex("embedded:3")).toBe(3);
    expect(embeddedStreamIndex("file:3")).toBeNull();
    expect(subtitleFileIndex("file:12")).toBe(12);
    expect(subtitleFileIndex(null)).toBeNull();
  });
});

describe("labels", () => {
  it("describes an audio track", () => {
    expect(
      audioLabel(audio({ language: "en", channels: 6, codec: "ac3" }), "en"),
    ).toBe("English · 5.1 · AC3");
    expect(
      audioLabel(audio({ language: "ru", title: "Dub", channels: 2 }), "en"),
    ).toBe("Russian (Dub) · 2.0 · AAC");
    expect(audioLabel(audio({ channels: 1, codec: "opus" }), "en")).toBe(
      "Unknown · Mono · Opus",
    );
  });

  it("names channel layouts", () => {
    expect(channelLayout(8)).toBe("7.1");
    expect(channelLayout(3)).toBe("3 ch");
  });

  it("marks picture subtitles as burned in", () => {
    expect(
      subtitleDetail(
        sub({ codec: "hdmv_pgs_subtitle", isText: false, title: "Full" }),
      ),
    ).toBe("Full · PGS · burned in");
    expect(
      subtitleDetail(sub({ source: "file", title: "Sintel.en.srt" })),
    ).toBe("Sintel.en.srt · file");
  });
});

describe("qualityOptions", () => {
  const media = (height: number) =>
    ({ video: { height } }) as unknown as MediaInfo;

  it("offers the original plus every preset below it", () => {
    expect(qualityOptions(media(1080)).map((o) => o.value)).toEqual([
      "original",
      "720p",
      "480p",
      "360p",
    ]);
    expect(qualityOptions(media(1080))[0]?.label).toBe("Original (1080p)");
  });

  it("only offers the original for small videos", () => {
    expect(qualityOptions(media(360)).map((o) => o.value)).toEqual([
      "original",
    ]);
  });

  it("offers presets below odd source heights", () => {
    expect(qualityOptions(media(800)).map((o) => o.value)).toEqual([
      "original",
      "720p",
      "480p",
      "360p",
    ]);
  });

  it("works without media info", () => {
    expect(qualityOptions(null)).toEqual([
      { value: "original", label: "Original" },
    ]);
  });
});

describe("initialSelection", () => {
  const media = {
    audioTracks: [
      audio({ index: 0, language: "en", isDefault: true }),
      audio({ index: 1, language: "ja" }),
    ],
    subtitleTracks: [
      sub({ id: "embedded:0", language: "en", isForced: true }),
      sub({ id: "file:4", source: "file", language: "en" }),
      sub({ id: "file:5", source: "file", language: "fr" }),
    ],
  };
  const automatic = { audioLanguage: null, subtitleLanguage: null };

  it("uses the file's own choices when nothing was chosen (Automatic)", () => {
    // Default audio (null = let the engine keep direct play), and the
    // forced track in the audio's language.
    expect(initialSelection(media, automatic)).toEqual({
      audioTrack: null,
      subtitleId: "embedded:0",
    });
  });

  it("follows the language preferences from Settings", () => {
    expect(
      initialSelection(media, { audioLanguage: "ja", subtitleLanguage: "fr" }),
    ).toEqual({ audioTrack: 1, subtitleId: "file:5" });
    expect(
      initialSelection(media, {
        audioLanguage: "en",
        subtitleLanguage: SUBTITLES_OFF,
      }),
    ).toEqual({ audioTrack: null, subtitleId: null });
  });

  it("restores the tracks saved with the position over the preferences", () => {
    const preferences = { audioLanguage: "en", subtitleLanguage: "fr" };
    expect(
      initialSelection(media, preferences, {
        audioTrack: 1,
        subtitle: "file:4",
      }),
    ).toEqual({ audioTrack: 1, subtitleId: "file:4" });
  });

  it("reads saved nulls as the default audio track and subtitles off", () => {
    const preferences = { audioLanguage: "ja", subtitleLanguage: "fr" };
    expect(
      initialSelection(media, preferences, {
        audioTrack: null,
        subtitle: null,
      }),
    ).toEqual({ audioTrack: null, subtitleId: null });
  });

  it("falls back to the preferences for saved tracks that are gone", () => {
    const preferences = { audioLanguage: "ja", subtitleLanguage: "fr" };
    expect(
      initialSelection(media, preferences, {
        audioTrack: 7,
        subtitle: "file:99",
      }),
    ).toEqual({ audioTrack: 1, subtitleId: "file:5" });
  });

  it("works without media info", () => {
    expect(initialSelection(null, automatic)).toEqual({
      audioTrack: null,
      subtitleId: null,
    });
  });
});

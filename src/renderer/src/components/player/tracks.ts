import type {
  AudioTrack,
  FileProgress,
  MediaInfo,
  Quality,
  SubtitleTrack,
} from "../../../../shared/engine-api";
import { SUBTITLES_OFF } from "../../../../shared/settings";
import { languageName, sameLanguage } from "@/lib/languages";

/** The viewer's choices; everything else in a playback request follows from them. */
export type Selection = {
  /** AudioTrack.index, null = the file's default. */
  audioTrack: number | null;
  /** SubtitleTrack.id, null = off. */
  subtitleId: string | null;
  quality: Quality;
};

/** Preferred language → the file's default track → the first one. */
export function pickAudio(
  tracks: AudioTrack[],
  preferredLanguage: string | null,
): AudioTrack | null {
  if (preferredLanguage) {
    const match = tracks.find((track) =>
      sameLanguage(track.language, preferredLanguage),
    );
    if (match) return match;
  }
  return defaultAudio(tracks);
}

/**
 * - SUBTITLES_OFF → none.
 * - A preferred language → its best track: full text subtitles first, then
 *   picture ones (burned in), forced-only tracks last.
 * - Otherwise a forced text track in the audio's language (the few lines in
 *   another language, e.g. signs). Never a picture one here: burning it in
 *   means converting the whole video, too costly to do unasked.
 */
export function pickSubtitle(
  tracks: SubtitleTrack[],
  preference: string | null,
  audioLanguage: string | null,
): SubtitleTrack | null {
  if (preference === SUBTITLES_OFF) return null;

  if (preference) {
    const rank = (track: SubtitleTrack) =>
      (track.isForced ? 2 : 0) + (track.isText ? 0 : 1);
    const candidates = tracks
      .filter((track) => sameLanguage(track.language, preference))
      .sort((a, b) => rank(a) - rank(b));
    if (candidates[0]) return candidates[0];
  }

  return (
    tracks.find(
      (track) =>
        track.isForced &&
        track.isText &&
        sameLanguage(track.language, audioLanguage),
    ) ?? null
  );
}

/**
 * What C / the subtitles button turns on when nothing was on before: the
 * first language in `languages` that has a track (saved choice, the
 * browser's language, the audio's), else any text track. Never just "the
 * first file in the torrent", which is often some other language.
 */
export function subtitleToTurnOn(
  tracks: SubtitleTrack[],
  languages: (string | null)[],
): SubtitleTrack | null {
  for (const language of languages) {
    const track = language ? pickSubtitle(tracks, language, null) : null;
    if (track) return track;
  }
  return tracks.find((track) => track.isText) ?? tracks[0] ?? null;
}

/** What the playback request needs to know about the chosen subtitle. */
export function subtitleNeeds(
  tracks: SubtitleTrack[],
  subtitleId: string | null,
) {
  const track = tracks.find((item) => item.id === subtitleId) ?? null;
  return {
    /** Picture subtitles can only be shown burned into the video. */
    burnSubtitle: track && !track.isText ? track.id : null,
    /** Embedded text cues only come out of an ffmpeg run. */
    embeddedSubtitles: track?.source === "embedded" && track.isText,
  };
}

/** The viewer's language preferences (Settings → Playback). */
export type LanguagePreferences = {
  /** null = Automatic: the file's default track. */
  audioLanguage: string | null;
  /** null = Automatic (default/forced tracks), SUBTITLES_OFF = never. */
  subtitleLanguage: string | null;
};

/**
 * The tracks a file starts with.
 * - Resuming: the tracks saved with the position (the choice made for this
 *   file wins over the general preferences), when the file still has them.
 * - Otherwise, or for a track that's gone: the language preferences.
 *
 * The audio track is null when it's the file's default, so the engine can
 * keep playing the file directly.
 */
export function initialSelection(
  media: Pick<MediaInfo, "audioTracks" | "subtitleTracks"> | null,
  preferences: LanguagePreferences,
  saved: Pick<FileProgress, "audioTrack" | "subtitle"> | null = null,
): Pick<Selection, "audioTrack" | "subtitleId"> {
  const audioTracks = media?.audioTracks ?? [];
  const subtitleTracks = media?.subtitleTracks ?? [];

  const savedAudio =
    saved && saved.audioTrack !== null
      ? audioTracks.find((track) => track.index === saved.audioTrack)
      : undefined;
  // Saved null = the file's default track, which is always there.
  const audio =
    saved && (saved.audioTrack === null || savedAudio)
      ? (savedAudio ?? defaultAudio(audioTracks))
      : pickAudio(audioTracks, preferences.audioLanguage);

  const savedSubtitle =
    typeof saved?.subtitle === "string"
      ? subtitleTracks.find((track) => track.id === saved.subtitle)
      : undefined;
  // Saved null = subtitles were off.
  const subtitle =
    saved && (saved.subtitle === null || savedSubtitle)
      ? (savedSubtitle ?? null)
      : pickSubtitle(
          subtitleTracks,
          preferences.subtitleLanguage,
          audio?.language ?? null,
        );

  return {
    audioTrack: audio && !audio.isDefault ? audio.index : null,
    subtitleId: subtitle?.id ?? null,
  };
}

function defaultAudio(tracks: AudioTrack[]): AudioTrack | null {
  return tracks.find((track) => track.isDefault) ?? tracks[0] ?? null;
}

/** "embedded:3" → 3, anything else → null. */
export function embeddedStreamIndex(id: string | null) {
  const match = id ? /^embedded:(\d+)$/.exec(id) : null;
  return match?.[1] ? Number(match[1]) : null;
}

/** "file:7" → 7, anything else → null. */
export function subtitleFileIndex(id: string | null) {
  const match = id ? /^file:(\d+)$/.exec(id) : null;
  return match?.[1] ? Number(match[1]) : null;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const CODEC_NAMES: Record<string, string> = {
  aac: "AAC",
  ac3: "AC3",
  eac3: "E-AC3",
  dts: "DTS",
  truehd: "TrueHD",
  opus: "Opus",
  vorbis: "Vorbis",
  flac: "FLAC",
  mp3: "MP3",
  mp2: "MP2",
  pcm_s16le: "PCM",
  pcm_s24le: "PCM",
  h264: "H.264",
  hevc: "HEVC",
  av1: "AV1",
  vp9: "VP9",
  vp8: "VP8",
  mpeg4: "MPEG-4",
  subrip: "SRT",
  ass: "ASS",
  ssa: "SSA",
  mov_text: "MP4 text",
  webvtt: "WebVTT",
  hdmv_pgs_subtitle: "PGS",
  dvd_subtitle: "VobSub",
  dvb_subtitle: "DVB",
};

export function codecName(codec: string) {
  return CODEC_NAMES[codec] ?? codec.toUpperCase();
}

/** 2 → "2.0", 6 → "5.1", 8 → "7.1", 1 → "Mono". */
export function channelLayout(channels: number) {
  if (channels === 1) return "Mono";
  if (channels === 2) return "2.0";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} ch`;
}

/** "English · 5.1 · AC3", "Russian (Dub) · 2.0 · AAC". */
export function audioLabel(track: AudioTrack, locale?: string) {
  const name = languageName(track.language, locale);
  const title = track.title ? ` (${track.title})` : "";
  return `${name}${title} · ${channelLayout(track.channels)} · ${codecName(track.codec)}`;
}

/** Short form for the settings row: "English · 5.1". */
export function audioShortLabel(track: AudioTrack, locale?: string) {
  return `${languageName(track.language, locale)} · ${channelLayout(track.channels)}`;
}

export function subtitleLabel(track: SubtitleTrack, locale?: string) {
  const name = languageName(track.language, locale);
  return track.isForced ? `${name} (forced)` : name;
}

/** The muted second line: title / file name and what kind of track it is. */
export function subtitleDetail(track: SubtitleTrack) {
  const parts: string[] = [];
  if (track.title) parts.push(track.title);
  parts.push(track.source === "file" ? "file" : codecName(track.codec));
  if (!track.isText) parts.push("burned in");
  return parts.join(" · ");
}

// ─── Quality ─────────────────────────────────────────────────────────────────

const PRESETS: { quality: Exclude<Quality, "original">; height: number }[] = [
  { quality: "1080p", height: 1080 },
  { quality: "720p", height: 720 },
  { quality: "480p", height: 480 },
  { quality: "360p", height: 360 },
];

export type QualityOption = { value: Quality; label: string; hint?: string };

/** Original (the source height) plus every preset below it. */
export function qualityOptions(media: MediaInfo | null): QualityOption[] {
  const height = media?.video?.height ?? null;
  const options: QualityOption[] = [
    { value: "original", label: height ? `Original (${height}p)` : "Original" },
  ];
  if (!height) return options;
  for (const preset of PRESETS) {
    if (preset.height < height) {
      options.push({
        value: preset.quality,
        label: preset.quality,
        hint: "Converted while it plays · uses more CPU",
      });
    }
  }
  return options;
}

export function qualityLabel(quality: Quality, media: MediaInfo | null) {
  return (
    qualityOptions(media).find((option) => option.value === quality)?.label ??
    quality
  );
}

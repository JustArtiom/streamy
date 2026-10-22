import type { SubtitleTrack, TorrentFile } from "../../shared/engine-api";
import { languageFromFileName, startsWithName } from "./languages";

/*
 * Subtitle files that come with a video in the same torrent
 * (Sintel.en.srt next to Sintel.mp4, or Subs/S01E02/English.srt).
 */

/** Text subtitle formats we can turn into cues, and their ffmpeg codec names. */
const TEXT_SUBTITLE_CODECS: Record<string, string> = {
  srt: "subrip",
  vtt: "webvtt",
  ass: "ass",
  ssa: "ssa",
};

/** "Movie.en.SRT" → "srt". */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** "Movie.en.srt" → "Movie.en". */
export function baseNameOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function isTextSubtitleFile(file: Pick<TorrentFile, "name" | "kind">) {
  return (
    file.kind === "subtitle" && extensionOf(file.name) in TEXT_SUBTITLE_CODECS
  );
}

/** "Show.S01E02.mkv" / "Show 1x02.srt" → "1x2", else null. */
export function episodeTag(name: string): string | null {
  const match =
    /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?![0-9])/i.exec(name) ??
    /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?![0-9])/i.exec(name);
  if (!match) return null;
  return `${Number(match[1])}x${Number(match[2])}`;
}

/** The folders of a path inside the torrent: "A/B/c.srt" → ["A", "B"]. */
function foldersOf(path: string): string[] {
  return path.split("/").slice(0, -1);
}

function belongsTo(video: TorrentFile, subtitle: TorrentFile): boolean {
  const videoBase = baseNameOf(video.name);
  if (startsWithName(subtitle.name, videoBase)) return true;

  const tag = episodeTag(video.name);
  if (tag && episodeTag(subtitle.path) === tag) return true;

  const lowerBase = videoBase.toLowerCase();
  return foldersOf(subtitle.path).some((f) => f.toLowerCase() === lowerBase);
}

/**
 * The text subtitle files that go with `video`. One video in the torrent →
 * all of them. Several videos (a season) → only the files named after it,
 * with the same episode tag, or in a folder named after it.
 */
export function subtitleFilesFor(
  video: TorrentFile,
  files: TorrentFile[],
): TorrentFile[] {
  const subtitles = files.filter(isTextSubtitleFile);
  const videos = files.filter((file) => file.kind === "video");
  if (videos.length <= 1) return subtitles;
  return subtitles.filter((subtitle) => belongsTo(video, subtitle));
}

/** A subtitle file as a track of the video's media info ("file:<index>"). */
export function toSubtitleTrack(
  video: TorrentFile,
  file: TorrentFile,
): SubtitleTrack {
  const words = baseNameOf(file.name)
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return {
    id: `file:${file.index}`,
    source: "file",
    codec: TEXT_SUBTITLE_CODECS[extensionOf(file.name)] ?? "subrip",
    language: languageFromFileName(file.name, baseNameOf(video.name)),
    title: file.name,
    isDefault: false,
    isForced: words.includes("forced"),
    isText: true,
  };
}

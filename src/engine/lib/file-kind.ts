import { extname } from "node:path";
import type { FileKind } from "../../shared/engine-api";

const KINDS: Record<Exclude<FileKind, "other">, string[]> = {
  video: [
    "mp4",
    "m4v",
    "mkv",
    "webm",
    "avi",
    "mov",
    "wmv",
    "flv",
    "ts",
    "m2ts",
    "mts",
    "mpg",
    "mpeg",
    "ogv",
    "3gp",
  ],
  audio: [
    "mp3",
    "m4a",
    "aac",
    "ac3",
    "eac3",
    "dts",
    "flac",
    "ogg",
    "opus",
    "wav",
    "mka",
  ],
  subtitle: ["srt", "vtt", "ass", "ssa", "sub", "idx", "sup"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp"],
};

const KIND_BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(KINDS).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind as FileKind] as const),
  ),
);

// What the stream endpoint sends as Content-Type. Browsers sniff video
// anyway, but a right type helps them pick the right demuxer at once.
const CONTENT_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mov: "video/quicktime",
  ts: "video/mp2t",
  m2ts: "video/mp2t",
  mts: "video/mp2t",
  vtt: "text/vtt",
  srt: "application/x-subrip",
};

/** "Movie.MKV" → "mkv" */
export function fileExtension(name: string): string {
  return extname(name).slice(1).toLowerCase();
}

/** Guessed from the extension. */
export function fileKind(name: string): FileKind {
  return KIND_BY_EXTENSION.get(fileExtension(name)) ?? "other";
}

export function contentType(name: string): string {
  return CONTENT_TYPES[fileExtension(name)] ?? "application/octet-stream";
}

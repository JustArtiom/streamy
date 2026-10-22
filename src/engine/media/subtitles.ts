import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import chardet from "chardet";
import type { Cue } from "../../shared/engine-api";
import { cachePaths, getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";
import { logger } from "../lib/logger";
import { ensureVideoFolder, makeDirIn } from "../lib/video-folder";
import { type TorrentFileHandle, torrentService } from "../torrents/service";
import { buildSubtitleConvertArgs, isSubtitleFileFormat } from "./ffmpeg-args";
import { lastLines, runProcess } from "./run";
import { extensionOf, isTextSubtitleFile } from "./subtitle-files";
import { parseVtt } from "./vtt";

/*
 * Subtitles as cues for the player's own overlay:
 * - files in the torrent (.srt/.vtt/.ass/.ssa): downloaded whole, converted
 *   once by ffmpeg (which also fixes old encodings like cp1251), cached in
 *   <cacheDir>/subtitles/<infoHash>/;
 * - embedded text tracks: the sub_<n>.vtt files a playback session's
 *   ffmpeg writes as it goes.
 */

const log = logger.child({ module: "subtitles" });

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

const fileCues = new Map<string, Promise<Cue[]>>();

/** Parsed sub_<n>.vtt files, re-parsed when they grow. */
const embeddedCues = new Map<string, { size: number; cues: Cue[] }>();

/**
 * Where each torrent's converted files went. Remembered, so a change of
 * video folder doesn't leave them behind when the torrent goes.
 */
const convertedDirs = new Map<string, Set<string>>();

let unsubscribeRemovals: (() => void) | null = null;

function hookRemovals() {
  if (unsubscribeRemovals) return;
  try {
    unsubscribeRemovals = torrentService.onRemoved((infoHash) => {
      void subtitlesService.forgetTorrent(infoHash);
    });
  } catch (error) {
    log.warn({ err: error }, "Couldn't listen for removed torrents");
  }
}

function startsWithBom(bytes: Buffer) {
  return (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff) ||
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
  );
}

/**
 * The charset to pass to ffmpeg's -sub_charenc, or null when ffmpeg reads
 * it fine already (UTF-8, ASCII, or UTF-16 with a BOM).
 */
export function subtitleCharset(bytes: Buffer): string | null {
  if (startsWithBom(bytes)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return null; // Valid UTF-8 (ASCII included), whatever chardet thinks.
  } catch {
    // Not UTF-8: guess below.
  }
  const detected = chardet.detect(bytes);
  if (!detected || /^(utf-8|ascii)$/i.test(detected)) return null;
  return detected;
}

async function convertFile(file: TorrentFileHandle): Promise<Cue[]> {
  const dir = join(cachePaths().subtitles, file.infoHash);
  const jsonPath = join(dir, `${file.index}.json`);

  try {
    return JSON.parse(await readFile(jsonPath, "utf8")) as Cue[];
  } catch {
    // Not converted yet.
  }

  const format = extensionOf(file.name);
  if (!isSubtitleFileFormat(format)) {
    throw new AppError(
      ErrorCode.BadRequest,
      "Only text subtitle files are supported",
    );
  }

  const bytes = await file.readAll({ maxBytes: MAX_SUBTITLE_BYTES });
  const charset = subtitleCharset(bytes);
  // 503 when the video folder is gone (an unplugged drive).
  await ensureVideoFolder();
  await makeDirIn(dir);
  const dirs = convertedDirs.get(file.infoHash) ?? new Set();
  dirs.add(dir);
  convertedDirs.set(file.infoHash, dirs);
  const source = join(dir, `${file.index}.${format}`);
  await writeFile(source, bytes);

  const convert = (withCharset: string | null) =>
    runProcess(
      getRuntime().ffmpegPath,
      buildSubtitleConvertArgs(source, format, withCharset),
      { timeoutMs: 30_000 },
    );
  let result = await convert(charset);
  // A charset name iconv doesn't know: better some odd letters than nothing.
  if (result.code !== 0 && charset) {
    log.warn(
      { charset, stderr: lastLines(result.stderr, 3) },
      "Retrying subtitle without charset",
    );
    result = await convert(null);
  }
  if (result.code !== 0) {
    log.warn(
      {
        infoHash: file.infoHash,
        fileIndex: file.index,
        stderr: lastLines(result.stderr, 5),
      },
      "Subtitle conversion failed",
    );
    throw new AppError(
      ErrorCode.BadRequest,
      "Couldn't read this subtitle file",
    );
  }

  const cues = parseVtt(result.stdout.toString("utf8"), { complete: true });
  await writeFile(jsonPath, JSON.stringify(cues));
  log.info(
    {
      infoHash: file.infoHash,
      fileIndex: file.index,
      charset,
      cues: cues.length,
    },
    "Subtitle file converted",
  );
  return cues;
}

export const subtitlesService = {
  /** All cues of a subtitle file in the torrent. */
  getFileCues(infoHash: string, fileIndex: number): Promise<Cue[]> {
    const file = torrentService.getFile(infoHash, fileIndex);
    if (!isTextSubtitleFile(file)) {
      throw new AppError(
        ErrorCode.BadRequest,
        "Only text subtitle files are supported",
      );
    }
    torrentService.touch(infoHash);
    hookRemovals();

    const key = `${infoHash}:${fileIndex}`;
    let promise = fileCues.get(key);
    if (!promise) {
      promise = convertFile(file);
      fileCues.set(key, promise);
      promise.catch(() => {
        if (fileCues.get(key) === promise) fileCues.delete(key);
      });
    }
    return promise;
  },

  /** Cues ffmpeg has written so far to a session's sub_<n>.vtt. */
  async readEmbeddedCues(path: string): Promise<Cue[]> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return []; // Nothing written yet.
    }
    const cached = embeddedCues.get(path);
    if (cached?.size === size) return cached.cues;

    // The last cue may be half-written: parseVtt skips it until it's done.
    const cues = parseVtt(await readFile(path, "utf8"));
    embeddedCues.set(path, { size, cues });
    return cues;
  },

  /** Drops the parsed cues of a stopped session's folder. */
  forgetSessionDir(dir: string) {
    for (const path of embeddedCues.keys()) {
      if (path.startsWith(`${dir}${sep}`)) embeddedCues.delete(path);
    }
  },

  /** A removed torrent: drop its converted files. */
  async forgetTorrent(infoHash: string) {
    for (const key of fileCues.keys()) {
      if (key.startsWith(`${infoHash}:`)) fileCues.delete(key);
    }
    const dirs = convertedDirs.get(infoHash) ?? new Set();
    convertedDirs.delete(infoHash);
    dirs.add(join(cachePaths().subtitles, infoHash));
    await Promise.all(
      [...dirs].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  },

  /** Shutdown and tests: forget everything, stop listening. */
  reset() {
    fileCues.clear();
    embeddedCues.clear();
    convertedDirs.clear();
    unsubscribeRemovals?.();
    unsubscribeRemovals = null;
  },
};

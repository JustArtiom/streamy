import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ffmpegPath, MEDIA_CACHE_DIR } from "./paths";

// The test torrent: small but real videos made with the bundled ffmpeg
// (`-f lavfi`, nothing downloaded). Made once and cached in .e2e/media/,
// in a folder named after a hash of this file: changing anything here makes
// a new set.
//
//   Streamy E2E/
//     Sample.mp4      H.264 + AAC, 3 min, 480p. Plays directly in <video>.
//                     480p, so the player offers 360p (it only offers
//                     qualities below the source's): that's a transcode.
//     Sample.en.srt   its external subtitles
//     Dub.mkv         H.264 360p + 2 AAC tracks (eng, deu) + embedded SRT
//                     (eng). Chromium can't play MKV: the engine remuxes it.
//
// The picture is ffmpeg's `testsrc`, which draws the current second in big
// digits (a burnt-in timecode: handy in screenshots and traces). Keyframes
// every 2 s, so seeks land close to where they aim.
//
// Every subtitle cue lasts exactly 2 s and they follow each other without a
// gap, so some line is always on screen while subtitles are on, and the
// line shown says where the video is: cue N covers [2N, 2N + 2).

export const TORRENT_NAME = "Streamy E2E";

export const SAMPLE = {
  name: "Sample.mp4",
  seconds: 180,
  size: "854x480",
} as const;
export const SAMPLE_SUBTITLES = { name: "Sample.en.srt" } as const;
export const DUB = { name: "Dub.mkv", seconds: 120, size: "640x360" } as const;

/** How long each subtitle cue lasts. */
export const CUE_SECONDS = 2;
export const externalCue = (index: number): string => `External cue ${index}`;
export const embeddedCue = (index: number): string => `Embedded cue ${index}`;

const run = promisify(execFile);

/** This version of the media: a hash of this file. */
function mediaVersion(): string {
  return createHash("sha256")
    .update(readFileSync(import.meta.filename))
    .digest("hex")
    .slice(0, 12);
}

/** The folder with this version of the media (made by ensureMedia()). */
export function mediaDir(): string {
  return join(MEDIA_CACHE_DIR, mediaVersion(), TORRENT_NAME);
}

/** Makes the media unless this version is cached already. */
export async function ensureMedia(): Promise<{
  dir: string;
  generated: boolean;
}> {
  const dir = mediaDir();
  if (existsSync(dir)) return { dir, generated: false };

  // Made next to it, then renamed: a half-made set is never used.
  const partial = `${dir}.partial-${process.pid}`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    await generate(partial);
    await rename(partial, dir);
  } finally {
    await rm(partial, { recursive: true, force: true });
  }

  // Older versions are no use anymore.
  for (const entry of await readdir(MEDIA_CACHE_DIR)) {
    if (entry !== mediaVersion()) {
      await rm(join(MEDIA_CACHE_DIR, entry), { recursive: true, force: true });
    }
  }
  return { dir, generated: true };
}

function srt(seconds: number, text: (index: number) => string): string {
  const stamp = (total: number) => {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)},000`;
  };
  const cues: string[] = [];
  for (let index = 0; index * CUE_SECONDS < seconds; index++) {
    const start = index * CUE_SECONDS;
    cues.push(
      `${index + 1}\n${stamp(start)} --> ${stamp(start + CUE_SECONDS)}\n${text(index)}\n`,
    );
  }
  return cues.join("\n");
}

async function ffmpeg(args: string[]): Promise<void> {
  await run(
    ffmpegPath("ffmpeg"),
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/** H.264 settings shared by both videos: small, keyframe every 2 s. */
// prettier-ignore
const H264 = [
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
  "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
  "-pix_fmt", "yuv420p",
];

async function generate(dir: string): Promise<void> {
  const picture = ({ size, seconds }: { size: string; seconds: number }) =>
    `testsrc=size=${size}:rate=24:duration=${seconds}`;
  const tone = (hz: number, seconds: number) =>
    `sine=frequency=${hz}:duration=${seconds}`;

  // prettier-ignore
  await ffmpeg([
    "-f", "lavfi", "-i", picture(SAMPLE),
    "-f", "lavfi", "-i", tone(440, SAMPLE.seconds),
    ...H264,
    "-c:a", "aac", "-b:a", "64k",
    // The index first: the player can start before the end has arrived.
    "-movflags", "+faststart",
    join(dir, SAMPLE.name),
  ]);
  await writeFile(
    join(dir, SAMPLE_SUBTITLES.name),
    srt(SAMPLE.seconds, externalCue),
  );

  // The embedded subtitles start as an SRT file outside the torrent folder.
  const embedded = `${dir}-embedded.srt`;
  await writeFile(embedded, srt(DUB.seconds, embeddedCue));
  try {
    // prettier-ignore
    await ffmpeg([
      "-f", "lavfi", "-i", picture(DUB),
      "-f", "lavfi", "-i", tone(440, DUB.seconds),
      "-f", "lavfi", "-i", tone(660, DUB.seconds),
      "-i", embedded,
      "-map", "0:v", "-map", "1:a", "-map", "2:a", "-map", "3:s",
      ...H264,
      "-c:a", "aac", "-b:a", "64k", "-c:s", "srt",
      "-metadata:s:a:0", "language=eng",
      "-metadata:s:a:1", "language=deu",
      "-metadata:s:s:0", "language=eng",
      join(dir, DUB.name),
    ]);
  } finally {
    await rm(embedded, { force: true });
  }
}

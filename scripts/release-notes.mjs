// Prints the notes for a GitHub Release, from .github/release-notes.md.
// The release workflow (.github/workflows/release.yml) uses it for the draft.
//
//   node scripts/release-notes.mjs                 the notes, for package.json's version
//   node scripts/release-notes.mjs --source-asset  just the ffmpeg source file's name
//
// The template's {{placeholders}} come from package.json (version) and
// scripts/ffmpeg.json (the pinned ffmpeg, so the notes always point at the
// exact source of the build inside the app). An unknown placeholder is an
// error, so a typo never ends up in a release.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

/** "jellyfin-ffmpeg-8.1.3-1-source.tar.gz": what the workflow attaches. */
export function sourceAssetName(pin) {
  return `${pin.name}-${pin.version}-source.tar.gz`;
}

export function releaseNotes() {
  const { version } = readJson("package.json");
  const pin = readJson("scripts/ffmpeg.json");
  const values = {
    version,
    "ffmpeg.name": pin.name,
    "ffmpeg.version": pin.version,
    "ffmpeg.ffmpegVersion": pin.ffmpegVersion,
    "ffmpeg.tag": pin.tag,
    "ffmpeg.commit": pin.commit,
    "ffmpeg.sourceUrl": pin.sourceUrl,
    "ffmpeg.sourceAsset": sourceAssetName(pin),
  };
  const template = readFileSync(join(ROOT, ".github/release-notes.md"), "utf8");
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    if (typeof value !== "string" || value === "") {
      throw new Error(`release-notes.md: unknown placeholder {{${key}}}`);
    }
    return value;
  });
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { "source-asset": { type: "boolean", default: false } },
    });
    process.stdout.write(
      values["source-asset"]
        ? `${sourceAssetName(readJson("scripts/ffmpeg.json"))}\n`
        : releaseNotes(),
    );
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exitCode = 1;
  }
}

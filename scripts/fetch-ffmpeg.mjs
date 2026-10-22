// Downloads the ffmpeg + ffprobe build pinned in scripts/ffmpeg.json into
// vendor/ffmpeg/<platform>-<arch>/. Dev runs use it from there, and
// electron-builder copies it into the app (see electron-builder.yml).
//
//   npm run ffmpeg                                    this computer's platform/arch
//   npm run ffmpeg -- --platform win32 --arch arm64   another target
//   npm run ffmpeg -- --force                         download and extract again
//   npm run ffmpeg -- --print-binary-hashes           for a new pin (see below)
//
// Steps: download the archive (or reuse a cached copy), check its SHA-256,
// extract the two binaries with the system `tar` into a scratch folder,
// check their SHA-256 too (`binarySha256`), then swap the finished folder
// into place. A re-run with the same pin does nothing, but only after
// hashing the binaries already in vendor/ffmpeg again: a folder restored
// from a CI cache, or changed by anything else, is never trusted as it is.
//
// No npm packages needed: `tar` ships with macOS, Windows 10+ and Linux.
// macOS and Windows have bsdtar, which reads .tar.xz and .zip. Linux has GNU
// tar, which reads .tar.xz but not .zip (so fetch Windows builds on Windows
// or macOS, or install bsdtar).
//
// electron-builder also runs `beforePack` (bottom of this file), so every
// package gets the right build for its target even if nobody ran this first.
//
// Updating the pin: pick a release on
// https://github.com/jellyfin/jellyfin-ffmpeg/releases and copy each portable
// GPL asset's name, URL, size and `digest` from
// https://api.github.com/repos/jellyfin/jellyfin-ffmpeg/releases/tags/<tag>
// into ffmpeg.json, along with the version, tag, commit and source URL.
// Check the paths inside the archives with `tar -tf <archive>`. Then run
// `npm run ffmpeg -- --print-binary-hashes` (on a Mac or Windows: it reads
// .zip files) and copy what it prints into each build's `binarySha256`.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  rmSync,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PIN_FILE = join(ROOT, "scripts/ffmpeg.json");
const VENDOR = join(ROOT, "vendor/ffmpeg");
// Outside the project so `git clean` or a fresh clone doesn't throw it away.
// Shared temp folders can be written by anyone, so cached files are always
// checked again before use.
const CACHE = join(tmpdir(), "streamy-ffmpeg-cache");
const MARKER = ".version";

const PLATFORMS = ["darwin", "win32", "linux"];
const ARCHES = ["x64", "arm64"];
// electron-builder passes the arch to hooks as a number (its `Arch` enum).
const BUILDER_ARCHES = ["ia32", "x64", "armv7l", "arm64", "universal"];

const ATTEMPTS = 3; // GitHub's download servers fail now and then
const STALL_MS = 60_000; // give up on a download that sends nothing for this long
const STALE_SCRATCH_MS = 60 * 60_000; // leftovers of a killed run

const USAGE = `Usage: node scripts/fetch-ffmpeg.mjs [options]

Downloads the ffmpeg build pinned in scripts/ffmpeg.json into
vendor/ffmpeg/<platform>-<arch>/.

Options:
  --platform <darwin|win32|linux>  target OS (default: this computer's)
  --arch <x64|arm64>               target CPU (default: this computer's)
  --force                          download and extract again
  --print-binary-hashes            print the SHA-256 of ffmpeg and ffprobe in
                                   every pinned archive (for ffmpeg.json's
                                   binarySha256), and change nothing
  -h, --help                       show this help`;

/** A problem we can explain in one line, so no stack trace. */
class FetchError extends Error {}

/** A download problem that may go away if we try again. */
class RetryableError extends FetchError {}

/** Paths to delete if the process is stopped half way (Ctrl+C). */
const pending = new Set();

const execFileAsync = promisify(execFile);
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const exeName = (name, platform) =>
  platform === "win32" ? `${name}.exe` : name;
const shortPath = (path) => relative(ROOT, path) || ".";
/**
 * Where download messages go: stdout, or stderr while stdout carries
 * --print-binary-hashes' JSON.
 */
const progress = { log: console.log };

/**
 * Makes sure vendor/ffmpeg/<platform>-<arch>/ holds the pinned build.
 * Returns that folder.
 */
export async function ensureFfmpeg({ platform, arch, force = false }) {
  const { pin, key, build } = await pinnedBuild(platform, arch);
  checkBuild(key, build);

  const dest = join(VENDOR, key);
  const label = `${pin.name} ${pin.version} for ${key}`;
  if (!force) {
    const installed = await checkInstalled(dest, platform, build);
    if (installed === "ok") {
      console.log(`${label} is already in ${shortPath(dest)}`);
      return dest;
    }
    if (installed === "changed") {
      console.log(
        `The ffmpeg in ${shortPath(dest)} doesn't match scripts/ffmpeg.json: replacing it`,
      );
    }
  }

  await mkdir(VENDOR, { recursive: true });
  await removeStaleScratch();
  // Scratch folder next to the destination: same disk, so the final move is
  // a rename, and nothing half-done ever sits at `dest`.
  const scratch = await mkdtemp(join(VENDOR, `.tmp-${key}-`));
  pending.add(scratch);
  try {
    const binaries = await extractBinaries(build, scratch);

    // Only the two files we expect, and only if they're exactly the pinned
    // ones (the archive's own hash was checked, but this is what ships).
    const out = join(scratch, "out");
    await mkdir(out);
    for (const name of ["ffmpeg", "ffprobe"]) {
      const hash = await hashFile(binaries[name]);
      if (hash !== build.binarySha256[name]) {
        throw new FetchError(
          `${build.files[name]} from ${build.asset} doesn't match scripts/ffmpeg.json, so it wasn't used.\n` +
            `  expected ${build.binarySha256[name]} (builds.${key}.binarySha256.${name})\n` +
            `  got      ${hash}`,
        );
      }
      const to = join(out, exeName(name, platform));
      await rename(binaries[name], to);
      if (platform !== "win32") await chmod(to, 0o755);
    }
    const marker = {
      name: pin.name,
      version: pin.version,
      asset: build.asset,
      sha256: build.sha256,
      binarySha256: build.binarySha256,
    };
    await writeFile(join(out, MARKER), JSON.stringify(marker, null, 2) + "\n");

    await swapIntoPlace(out, dest, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    pending.delete(scratch);
  }
  console.log(`${label} is ready in ${shortPath(dest)}`);
  return dest;
}

/**
 * Prints the SHA-256 of ffmpeg and ffprobe inside every pinned archive, as
 * JSON to paste into ffmpeg.json (`binarySha256`). The archives are
 * checked against their own pinned SHA-256 first. Changes nothing in vendor/.
 */
export async function printBinaryHashes() {
  progress.log = console.error;
  const pin = await readPin();
  await mkdir(VENDOR, { recursive: true });
  const hashes = {};
  for (const [key, build] of Object.entries(pin.builds ?? {})) {
    checkBuild(key, build, { binaryHashes: false });
    const scratch = await mkdtemp(join(VENDOR, `.tmp-${key}-`));
    pending.add(scratch);
    try {
      const binaries = await extractBinaries(build, scratch);
      hashes[key] = {
        ffmpeg: await hashFile(binaries.ffmpeg),
        ffprobe: await hashFile(binaries.ffprobe),
      };
    } finally {
      await rm(scratch, { recursive: true, force: true });
      pending.delete(scratch);
    }
  }
  console.log(JSON.stringify(hashes, null, 2));
}

/**
 * electron-builder hook (`beforePack` in electron-builder.yml): fetches the
 * pinned build for the target being packaged if it isn't there yet, so a
 * package never ships without ffmpeg (electron-builder only warns when an
 * extraResources folder is missing) or with a build from an older pin.
 */
export async function beforePack(context) {
  const arch = BUILDER_ARCHES[context.arch] ?? String(context.arch);
  await ensureFfmpeg({ platform: context.electronPlatformName, arch });
}

async function pinnedBuild(platform, arch) {
  if (!PLATFORMS.includes(platform)) {
    throw new FetchError(
      `Unknown platform "${platform}". Use one of: ${PLATFORMS.join(", ")}.`,
    );
  }
  if (!ARCHES.includes(arch)) {
    throw new FetchError(
      `Unknown arch "${arch}". Use one of: ${ARCHES.join(", ")}.`,
    );
  }
  const pin = await readPin();
  const key = `${platform}-${arch}`;
  const build = pin.builds?.[key];
  if (build == null) {
    throw new FetchError(
      `No ffmpeg build is pinned for ${key} in scripts/ffmpeg.json.`,
    );
  }
  return { pin, key, build };
}

/**
 * Downloads (or reuses) the verified archive into `scratch` and extracts
 * the two binaries. Returns their paths.
 */
async function extractBinaries(build, scratch) {
  const archive = join(scratch, build.asset);
  await getArchive(build, archive);
  const extracted = join(scratch, "extracted");
  await mkdir(extracted);
  await extract(build, archive, extracted);
  // Take only the two files we expect, by their known paths.
  return {
    ffmpeg: await archiveMember(extracted, build.files.ffmpeg),
    ffprobe: await archiveMember(extracted, build.files.ffprobe),
  };
}

/** A file's SHA-256 (hex). */
async function hashFile(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function readPin() {
  try {
    return JSON.parse(await readFile(PIN_FILE, "utf8"));
  } catch (error) {
    throw new FetchError(`Couldn't read scripts/ffmpeg.json: ${error.message}`);
  }
}

/** Catches typos in ffmpeg.json before they turn into confusing errors. */
function checkBuild(key, build, { binaryHashes = true } = {}) {
  const isMember = (path) =>
    typeof path === "string" &&
    path !== "" &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).includes("..");
  const isHash = (value) => /^[0-9a-f]{64}$/.test(value);
  const problems = [
    typeof build.asset === "string" && !/[\\/]/.test(build.asset)
      ? null
      : "asset",
    typeof build.url === "string" && build.url.startsWith("https://")
      ? null
      : "url",
    /^[0-9a-f]{64}$/.test(build.sha256) ? null : "sha256",
    Number.isInteger(build.size) && build.size > 0 ? null : "size",
    ["tar.xz", "zip"].includes(build.archive) ? null : "archive",
    isMember(build.files?.ffmpeg) ? null : "files.ffmpeg",
    isMember(build.files?.ffprobe) ? null : "files.ffprobe",
    !binaryHashes || isHash(build.binarySha256?.ffmpeg)
      ? null
      : "binarySha256.ffmpeg",
    !binaryHashes || isHash(build.binarySha256?.ffprobe)
      ? null
      : "binarySha256.ffprobe",
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new FetchError(
      `scripts/ffmpeg.json: builds.${key} has a missing or invalid ${problems.join(", ")}.`,
    );
  }
}

/**
 * "ok" when `dest` holds exactly the pinned binaries, "missing" when it holds
 * nothing usable (or an older pin's), "changed" when the binaries differ
 * from their pinned SHA-256. The `.version` marker only says which pin the
 * folder is meant to be; the binaries themselves are hashed every time.
 */
async function checkInstalled(dest, platform, build) {
  try {
    const marker = JSON.parse(await readFile(join(dest, MARKER), "utf8"));
    if (marker.sha256 !== build.sha256) return "missing";
    for (const name of ["ffmpeg", "ffprobe"]) {
      const file = join(dest, exeName(name, platform));
      if (!(await stat(file)).isFile()) return "missing";
      if ((await hashFile(file)) !== build.binarySha256[name]) {
        return "changed";
      }
    }
    return "ok";
  } catch {
    return "missing";
  }
}

/** Puts a verified copy of the archive at `file`: from the cache, or downloaded. */
async function getArchive(build, file) {
  const cached = join(CACHE, build.sha256, build.asset);
  if (await stat(cached).catch(() => null)) {
    // Copy and hash in one pass; extraction then reads only our own copy.
    const hash = await copyHashed(createReadStream(cached), file).catch(
      () => null,
    );
    if (hash === build.sha256) {
      progress.log(`Using the cached ${build.asset}`);
      return;
    }
    await rm(file, { force: true });
    await rm(cached, { force: true }); // damaged, or not ours
  }
  await download(build, file);
  await saveToCache(file, cached);
}

async function download(build, file) {
  progress.log(`Downloading ${build.asset} (${mb(build.size)})`);
  for (let attempt = 1; ; attempt++) {
    try {
      await downloadOnce(build, file);
      progress.log("SHA-256 verified");
      return;
    } catch (error) {
      // Never leave a partial or unverified archive behind.
      await rm(file, { force: true });
      if (!(error instanceof RetryableError) || attempt === ATTEMPTS) {
        throw error;
      }
      progress.log(`${error.message}. Retrying (${attempt + 1}/${ATTEMPTS})…`);
      await sleep(attempt * 3000);
    }
  }
}

async function downloadOnce(build, file) {
  // fetch() has no timeout of its own; abort if the data stops coming.
  const controller = new AbortController();
  let timer;
  const keepAlive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      controller.abort();
    }, STALL_MS);
  };
  const progress = createProgress();
  keepAlive();
  try {
    const response = await fetch(build.url, { signal: controller.signal });
    if (!response.ok || response.body == null) {
      const message = `HTTP ${response.status} ${response.statusText} from ${build.url}`;
      // 5xx and "too many requests" are worth another try; 404 etc. aren't.
      throw response.status >= 500 || response.status === 429
        ? new RetryableError(message)
        : new FetchError(message);
    }
    const total = Number(response.headers.get("content-length")) || build.size;
    const hash = await copyHashed(
      Readable.fromWeb(response.body),
      file,
      (n) => {
        keepAlive();
        progress(n, total);
      },
    );
    if (hash !== build.sha256) {
      throw new FetchError(
        `SHA-256 mismatch for ${build.asset}, so it was deleted.\n` +
          `  expected ${build.sha256} (scripts/ffmpeg.json)\n` +
          `  got      ${hash}`,
      );
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    if (controller.signal.aborted) {
      throw new RetryableError(
        `The download stalled (no data for ${STALL_MS / 1000} s)`,
      );
    }
    // Disk problems (full, no permission) come with a syscall; retrying won't help.
    if (error.syscall) throw error;
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new RetryableError(`Network error (${reason})`);
  } finally {
    clearTimeout(timer);
    progress.done();
  }
}

/** One self-updating progress line, only when a person is watching. */
function createProgress() {
  const tty = process.stdout.isTTY;
  let shownAt = 0;
  const update = (bytes, total) => {
    const now = Date.now();
    if (!tty || now - shownAt < 100) return;
    shownAt = now;
    const percent = Math.min(100, Math.floor((bytes / total) * 100));
    process.stdout.write(`\r  ${mb(bytes)} / ${mb(total)} (${percent}%)`);
  };
  update.done = () => {
    if (tty && shownAt > 0) process.stdout.write("\r\x1b[K");
  };
  return update;
}

/** Streams `source` into a new file and returns the file's SHA-256 (hex). */
async function copyHashed(source, file, onProgress) {
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    source,
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        bytes += chunk.length;
        onProgress?.(bytes);
        yield chunk;
      }
    },
    // "wx": fail rather than write through something already there.
    createWriteStream(file, { flags: "wx" }),
  );
  return hash.digest("hex");
}

/** Best effort: if this fails, the next run just downloads again. */
async function saveToCache(file, cached) {
  const partial = `${cached}.${process.pid}.partial`;
  pending.add(partial);
  try {
    await mkdir(dirname(cached), { recursive: true, mode: 0o700 });
    await copyFile(file, partial, constants.COPYFILE_EXCL);
    await rename(partial, cached);
  } catch (error) {
    await rm(partial, { force: true });
    progress.log(`(Couldn't cache the download: ${error.message})`);
  } finally {
    pending.delete(partial);
  }
}

/**
 * Extracts only the two binaries, with the system tar (no shell involved).
 * Tries each tar in order, skipping ones that aren't installed.
 */
async function extract(build, archive, into) {
  const members = [build.files.ffmpeg, build.files.ffprobe];
  const tools = tarCandidates(build.archive);
  for (const tool of tools) {
    try {
      await execFileAsync(tool, ["-xf", archive, "-C", into, ...members]);
      return;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      const output = String(error.stderr ?? "").trim() || error.message;
      throw new FetchError(
        `Couldn't extract ${build.asset} with ${tool}:\n  ` +
          output.replaceAll("\n", "\n  ") +
          tarHint(build.archive),
      );
    }
  }
  throw new FetchError(
    `Couldn't find tar (tried ${tools.join(", ")}).${tarHint(build.archive)}`,
  );
}

function tarCandidates(archiveType) {
  if (process.platform === "win32") {
    // Windows' own bsdtar first: a GNU tar from Git or MSYS may come first
    // on PATH, and it can't read .zip and takes "C:" for a remote host.
    const windows = process.env.SystemRoot ?? "C:\\Windows";
    return [join(windows, "System32", "tar.exe"), "tar"];
  }
  if (process.platform === "darwin") {
    // Apple's bsdtar, even if Homebrew's GNU tar comes first on PATH.
    return ["/usr/bin/tar", "tar"];
  }
  // Linux: GNU tar reads .tar.xz; only bsdtar (libarchive-tools) reads .zip.
  return archiveType === "zip" ? ["bsdtar", "tar"] : ["tar"];
}

function tarHint(archiveType) {
  if (process.platform !== "linux") return "";
  return archiveType === "zip"
    ? "\nGNU tar can't read .zip files. Install bsdtar (package libarchive-tools), or fetch Windows builds on Windows or macOS."
    : "\nGNU tar needs the xz tool for .tar.xz files (package xz-utils).";
}

/**
 * The real path of a file the archive should contain. Refuses anything that
 * isn't a plain file inside `root`: archive contents are untrusted, and a
 * symlink could point anywhere.
 */
async function archiveMember(root, member) {
  const file = join(root, member);
  const info = await lstat(file).catch(() => null);
  if (info == null) {
    throw new FetchError(
      `${member} isn't in the archive. Check "files" in scripts/ffmpeg.json.`,
    );
  }
  if (!info.isFile()) {
    throw new FetchError(`${member} in the archive isn't a regular file.`);
  }
  // A symlinked folder on the way could still lead outside `root`.
  const real = await realpath(file);
  const inside = relative(await realpath(root), real);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new FetchError(`${member} in the archive points outside it.`);
  }
  return real;
}

/** Replaces `dest` with `out`. Both are inside VENDOR, so these are renames. */
async function swapIntoPlace(out, dest, scratch) {
  // A folder can't be renamed over a non-empty one: move the old one aside.
  const old = join(scratch, "old");
  try {
    await rename(dest, old);
  } catch (error) {
    if (error.code !== "ENOENT") throw inUse(error, dest);
  }
  try {
    await rename(out, dest);
  } catch (error) {
    await rename(old, dest).catch(() => {}); // put the old one back
    throw inUse(error, dest);
  }
}

function inUse(error, dest) {
  return new FetchError(
    `Couldn't replace ${shortPath(dest)} (${error.code ?? error.message}). ` +
      "Is Streamy or ffmpeg running from it? Close it and try again.",
  );
}

/** Scratch folders left by a run that was killed. */
async function removeStaleScratch() {
  for (const name of await readdir(VENDOR)) {
    if (!name.startsWith(".tmp-")) continue;
    const path = join(VENDOR, name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_SCRATCH_MS) {
      await rm(path, { recursive: true, force: true });
    }
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        platform: { type: "string" },
        arch: { type: "string" },
        force: { type: "boolean", default: false },
        "print-binary-hashes": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    throw new FetchError(`${error.message}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values["print-binary-hashes"]) {
    await printBinaryHashes();
    return;
  }
  await ensureFfmpeg({
    platform: values.platform ?? process.platform,
    arch: values.arch ?? process.arch,
    force: values.force,
  });
}

// Run only as a command, not when electron-builder imports this for the hook.
// (`import.meta.main` needs Node 24.2+; the comparison covers older 24.x.)
if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    process.once(signal, () => {
      for (const path of pending)
        rmSync(path, { recursive: true, force: true });
      process.exit(code);
    });
  }
  main().catch((error) => {
    console.error(
      error instanceof FetchError ? `fetch-ffmpeg: ${error.message}` : error,
    );
    process.exitCode = 1;
  });
}

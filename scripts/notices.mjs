// Writes THIRD_PARTY_NOTICES.txt: the software inside Streamy that other
// people made, and the licence each comes with. It's shipped in the app
// (resources/THIRD_PARTY_NOTICES.txt) and shown in Settings → Advanced →
// "Third-party licences".
//
//   npm run notices                    writes vendor/THIRD_PARTY_NOTICES.txt
//   npm run notices -- --strict        and fails if a licence needs a look
//   npm run notices -- --out <file>    writes somewhere else
//
// What it lists:
//   1. ffmpeg and ffprobe (the pinned build in scripts/ffmpeg.json)
//   2. Electron, and where to find Chromium's licences
//   3. npm packages:
//      - the production dependency tree (`dependencies` in package.json and
//        everything they need), which electron-builder copies into the app;
//      - the packages Vite builds into the app's own code: every package the
//        source in src/ imports (React, React Router, hls.js, lucide, the
//        Geist fonts…), and what they need in turn.
//
// It also checks each package's licence against Streamy's (GPL-3.0-or-later)
// and lists the ones to look at: no licence, an unknown one, or one not
// known to be compatible. CI runs it with --strict, so a new dependency with
// such a licence fails the check until someone has looked at it (then add it
// to REVIEWED below, with the reason).
//
// electron-builder runs `afterExtract` (bottom of this file) for each
// platform/arch before it copies extraResources, so every package gets a
// fresh file even if nobody ran this first.
//
// No npm packages needed: only Node.js.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_OUT = join(ROOT, "vendor/THIRD_PARTY_NOTICES.txt");

/**
 * Licences that are fine inside a GPL-3.0-or-later program (the FSF's list:
 * https://www.gnu.org/licenses/license-list.html). Fonts under the OFL are
 * separate works the app displays, which the OFL allows.
 */
const COMPATIBLE = new Set([
  "0BSD",
  "Apache-2.0",
  "Artistic-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "ISC",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "WTFPL",
  "X11",
  "Zlib",
]);

const COMPATIBLE_LOWER = new Set([...COMPATIBLE].map((id) => id.toLowerCase()));

/** Old or loose names some packages use, and the SPDX id they mean. */
const ALIASES = {
  "Apache 2.0": "Apache-2.0",
  "Apache License 2.0": "Apache-2.0",
  Apache2: "Apache-2.0",
  "BSD-2": "BSD-2-Clause",
  "BSD-3": "BSD-3-Clause",
  "GPL-3.0": "GPL-3.0-only",
  "GPL-3.0+": "GPL-3.0-or-later",
  GPLv3: "GPL-3.0-only",
  "LGPL-3.0": "LGPL-3.0-only",
  "MIT/X11": "MIT",
  "MPL 2.0": "MPL-2.0",
  "Public Domain": "Unlicense",
};

/**
 * Packages whose package.json licence this script can't judge, and what a
 * person found when they read the package. Key: name@version, so a new
 * version gets looked at again.
 */
const REVIEWED = {
  "compact2string@1.4.1": {
    spdx: "MIT",
    why: 'package.json says "BSD", the README says "MIT Licence"; both are fine',
  },
};

/**
 * More for some packages, by name: licence files outside the package's top
 * folder, and libraries built into native add-ons that the package doesn't
 * list itself.
 */
const EXTRAS = {
  "utp-native": { files: ["deps/libutp/LICENSE"] },
  "node-datachannel": {
    note: `Its native add-on (node_datachannel.node) has these libraries built in:
  libdatachannel (MPL-2.0)   https://github.com/paullouisageneau/libdatachannel
  libjuice (MPL-2.0)         https://github.com/paullouisageneau/libjuice
  usrsctp (BSD-3-Clause)     https://github.com/sctplab/usrsctp
  libSRTP 2 (BSD-3-Clause)   https://github.com/cisco/libsrtp
  OpenSSL 3 (Apache-2.0)     https://www.openssl.org/source/license.html
Their licences are at those addresses.`,
  },
};

/** Files with a package's licence or notices, by name. */
const LICENCE_FILE =
  /^(?:licen[cs]e|copying|notice|copyright)(?:[-._][\w.-]*)?$/i;
const NOT_LICENCE_TEXT = /\.(?:js|cjs|mjs|ts|json|html?)$/i;

// ---------------------------------------------------------------- packages

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Where Node would find `name` when required from `fromDir`, or null. */
function resolvePackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dir === ROOT) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The names a package needs at run time (not its devDependencies). */
function runtimeDependencies(pkg) {
  const optionalPeers = new Set(
    Object.entries(pkg.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional)
      .map(([name]) => name),
  );
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}).filter(
      (name) => !optionalPeers.has(name),
    ),
  ];
}

/**
 * Every installed package reachable from `roots`, by directory. Optional
 * dependencies that aren't installed (e.g. for another OS) are skipped, the
 * way npm skips them.
 */
function collectPackages(roots, where, found) {
  const queue = roots.map((name) => ({ name, from: ROOT }));
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    const dir = resolvePackageDir(name, from);
    if (!dir || found.has(dir)) {
      if (dir) found.get(dir).where.add(where);
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    found.set(dir, { dir, pkg, where: new Set([where]) });
    for (const dependency of runtimeDependencies(pkg)) {
      queue.push({ name: dependency, from: dir });
    }
  }
  return found;
}

/** All source files of the app (not tests). */
function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") files.push(...sourceFiles(path));
    } else if (
      /\.(?:ts|tsx|css)$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

/** "react-dom/client" → "react-dom"; "@tanstack/react-query/x" → "@tanstack/react-query". */
function packageName(specifier) {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    return parts.length >= 2 && parts[0].length > 1
      ? `${parts[0]}/${parts[1]}`
      : null;
  }
  return parts[0] || null;
}

/**
 * Packages the source imports for real (not `import type`). Vite and
 * electron-vite build these into the app's code, unless they're in
 * `dependencies` (those stay in node_modules).
 */
function importedPackages() {
  const names = new Set();
  const anyImport =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|@import\s+)["']([^"'./][^"']*)["']/g;
  const typeOnly = /\bimport\s+type\s[^;]*?\bfrom\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    const typeImports = [...text.matchAll(typeOnly)].map((match) => match[1]);
    const imports = [...text.matchAll(anyImport)].map((match) => match[1]);
    for (const specifier of imports) {
      if (specifier.startsWith("node:")) continue;
      // Count only the imports that aren't all `import type`.
      const index = typeImports.indexOf(specifier);
      if (index !== -1) {
        typeImports.splice(index, 1);
        continue;
      }
      const name = packageName(specifier);
      if (name) names.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------- licences

/** The package.json licence as an SPDX expression ("MIT", "(MIT OR Apache-2.0)"). */
function declaredLicence(pkg) {
  const field = pkg.license ?? pkg.licenses;
  if (typeof field === "string") return field.trim() || null;
  if (Array.isArray(field)) {
    const types = field
      .map((item) => (typeof item === "string" ? item : item?.type))
      .filter((type) => typeof type === "string");
    return types.length > 1 ? `(${types.join(" OR ")})` : (types[0] ?? null);
  }
  if (typeof field?.type === "string") return field.type;
  return null;
}

/**
 * Whether an SPDX expression allows use in Streamy: "ok", or "check" with
 * a reason. OR: one compatible choice is enough. AND: all must be.
 */
export function judgeLicence(text) {
  if (!text) return { verdict: "missing", reason: "no licence" };
  const expression = ALIASES[text] ?? text;
  if (
    /^SEE LICEN[CS]E IN\b/i.test(expression) ||
    /^UNLICENSED$/i.test(expression)
  ) {
    return { verdict: "check", reason: `"${expression}"` };
  }
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];

  // expression := and ("OR" and)*;  and := atom ("AND" atom)*
  const parseOr = () => {
    let ok = parseAnd();
    while (peek()?.toUpperCase() === "OR") {
      next();
      const right = parseAnd();
      ok = ok || right;
    }
    return ok;
  };
  const parseAnd = () => {
    let ok = parseAtom();
    while (peek()?.toUpperCase() === "AND") {
      next();
      const right = parseAtom();
      ok = ok && right;
    }
    return ok;
  };
  const parseAtom = () => {
    const token = next();
    if (token === undefined) throw new Error("ends too early");
    if (token === "(") {
      const ok = parseOr();
      if (next() !== ")") throw new Error("missing )");
      return ok;
    }
    // "X WITH some-exception": exceptions only add permissions.
    if (peek()?.toUpperCase() === "WITH") {
      next();
      next();
    }
    // SPDX ids don't depend on case ("mit" is "MIT").
    const id = ALIASES[token] ?? token;
    return COMPATIBLE_LOWER.has(id.toLowerCase());
  };

  try {
    const ok = parseOr();
    if (position < tokens.length) throw new Error("unexpected words");
    return ok
      ? { verdict: "ok" }
      : { verdict: "check", reason: "not known to be GPL-3.0 compatible" };
  } catch (error) {
    return { verdict: "check", reason: `can't read it (${error.message})` };
  }
}

/** The package's licence and notice files (plus `extraFiles`), as text. */
function licenceTexts(dir, extraFiles = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return [
    ...names
      .filter((name) => LICENCE_FILE.test(name) && !NOT_LICENCE_TEXT.test(name))
      .filter((name) => statSync(join(dir, name)).isFile())
      .sort(),
    ...extraFiles.filter((name) => existsSync(join(dir, name))),
  ]
    .map((name) => ({
      name,
      text: readFileSync(join(dir, name), "utf8")
        .replace(/\r\n?/g, "\n")
        .replace(/\t/g, "    ")
        .trim(),
    }))
    .filter((file) => file.text.length > 0);
}

function repositoryUrl(pkg) {
  const repo = pkg.repository;
  const raw = typeof repo === "string" ? repo : repo?.url;
  if (typeof raw === "string") {
    const url = raw
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^ssh:\/\/git@/, "https://")
      .replace(/^git@github\.com:/, "https://github.com/")
      .replace(/\.git$/, "");
    if (/^https?:\/\//.test(url)) return url;
    // "github:user/repo" or plain "user/repo"
    const short = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
    if (short) return `https://github.com/${short[1]}`;
  }
  return typeof pkg.homepage === "string" ? pkg.homepage : null;
}

// ---------------------------------------------------------------- the file

const RULE = "-".repeat(78);
const DOUBLE_RULE = "=".repeat(78);

function heading(number, title) {
  return `${DOUBLE_RULE}\n${number}. ${title}\n${DOUBLE_RULE}`;
}

function ffmpegSection() {
  const pin = readJson(join(ROOT, "scripts/ffmpeg.json"));
  return `${heading(1, "FFmpeg")}

FFmpeg (${pin.name} ${pin.version})

Streamy includes the programs ffmpeg and ffprobe, unmodified, from the portable
GPL builds of ${pin.name} ${pin.version} (FFmpeg ${pin.ffmpegVersion} with the Jellyfin project's
patches): ${pin.releaseUrl}

They are licensed under the GNU General Public License, version 3 or (at your
option) any later version (built with --enable-gpl --enable-version3). They
statically include third-party libraries under GPL-compatible licenses, among
them x264, x265, libass, dav1d, SVT-AV1, zimg, libvpx, libopus, LAME, libvorbis,
FreeType, HarfBuzz and OpenSSL.

Complete source code: ${pin.sourceUrl}
(git tag ${pin.tag}, commit ${pin.commit}). The scripts that build these
binaries and pin each library's version are in the builder/ folder of that
source. A copy of that source is also attached to each Streamy release:
https://github.com/JustArtiom/streamy/releases

The GNU General Public License, version 3, is in Streamy's LICENSE file and at
https://www.gnu.org/licenses/gpl-3.0.html

FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.`;
}

function electronSection() {
  const dir = join(ROOT, "node_modules/electron");
  const pkg = readJson(join(dir, "package.json"));
  const texts = licenceTexts(dir);
  return `${heading(2, "Electron and Chromium")}

Electron ${pkg.version} (MIT), https://www.electronjs.org

Streamy runs on Electron, which includes Chromium and Node.js. Their
licences, and those of the many projects they include, are in the file
LICENSES.chromium.html that comes with Streamy:
  Windows and Linux: in Streamy's folder, next to the program
  macOS: Streamy.app/Contents/Resources/LICENSES.chromium.html

${texts.map((file) => file.text).join("\n\n")}`;
}

function packageEntry(entry) {
  const { pkg, licence, reviewed, texts, where } = entry;
  const lines = [
    RULE,
    `${pkg.name} ${pkg.version}`,
    `License: ${licence ?? "(none given)"}${reviewed ? ` (${reviewed})` : ""}`,
  ];
  const url = repositoryUrl(pkg);
  if (url) lines.push(`Source: ${url}`);
  if (where.has("bundled") && !where.has("app")) {
    lines.push("Built into Streamy's own code.");
  }
  const note = EXTRAS[pkg.name]?.note;
  if (note) lines.push("", note);
  lines.push("");
  if (texts.length === 0) {
    lines.push(
      `(This package has no licence file. Its package.json says: ${licence ?? "nothing"}.)`,
    );
  } else {
    for (const [index, file] of texts.entries()) {
      if (texts.length > 1)
        lines.push(`${index > 0 ? "\n" : ""}[${file.name}]`);
      lines.push(file.text);
    }
  }
  return lines.join("\n");
}

/**
 * Builds the notices. Returns the text and the packages to look at.
 * Throws if node_modules is missing (run `npm ci` first).
 */
export function buildNotices() {
  const app = readJson(join(ROOT, "package.json"));
  if (!existsSync(join(ROOT, "node_modules"))) {
    throw new Error("node_modules is missing: run `npm ci` first");
  }

  const found = new Map();
  collectPackages(Object.keys(app.dependencies ?? {}), "app", found);
  const bundled = [...importedPackages()].filter(
    (name) =>
      name !== "electron" &&
      name !== app.name &&
      (name in (app.devDependencies ?? {}) || name in (app.dependencies ?? {})),
  );
  collectPackages(bundled, "bundled", found);

  // One entry per name@version (npm can install the same one twice).
  const entries = new Map();
  for (const { dir, pkg, where } of found.values()) {
    const key = `${pkg.name}@${pkg.version}`;
    const existing = entries.get(key);
    if (existing) {
      for (const place of where) existing.where.add(place);
      continue;
    }
    const review = REVIEWED[key];
    const licence = review?.spdx ?? declaredLicence(pkg);
    entries.set(key, {
      key,
      dir,
      pkg,
      where: new Set(where),
      licence,
      reviewed: review?.why ?? null,
      judgement: judgeLicence(licence),
      texts: licenceTexts(dir, EXTRAS[pkg.name]?.files),
    });
  }
  const sorted = [...entries.values()].sort((a, b) =>
    a.key.localeCompare(b.key, "en"),
  );

  const nameWidth = Math.min(
    48,
    Math.max(...sorted.map((entry) => entry.key.length)),
  );
  const summary = sorted
    .map(
      (entry) =>
        `  ${entry.key.padEnd(nameWidth)}  ${entry.licence ?? "(none)"}`,
    )
    .join("\n");

  const text = `THIRD-PARTY NOTICES FOR STREAMY ${app.version}

Streamy is free software: you can redistribute it and/or modify it under the
terms of the GNU General Public License, version 3 or (at your option) any
later version. The full text is in the LICENSE file.
Source code: https://github.com/JustArtiom/streamy

Streamy is built on the work of the projects below. Each is listed with its
licence and the licence text it ships with. Thank you, all of you.

  1. FFmpeg
  2. Electron and Chromium
  3. npm packages (${sorted.length})

${ffmpegSection()}

${electronSection()}

${heading(3, `npm packages (${sorted.length})`)}

${summary}

${sorted.map(packageEntry).join("\n\n")}
`;

  return {
    text,
    count: sorted.length,
    toCheck: sorted.filter((entry) => entry.judgement.verdict !== "ok"),
    withoutText: sorted.filter((entry) => entry.texts.length === 0),
  };
}

/** Writes the notices to `out` and reports what needs a look. */
export async function writeNotices({ out = DEFAULT_OUT, strict = false } = {}) {
  const { text, count, toCheck, withoutText } = buildNotices();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text);
  const shown = relative(ROOT, out);
  console.log(
    `notices: ${count} npm packages → ${shown.startsWith("..") ? out : shown} (${Math.round(text.length / 1024)} KB)`,
  );
  if (withoutText.length > 0) {
    console.log(
      `notices: no licence file in ${withoutText.map((entry) => entry.key).join(", ")}`,
    );
  }
  if (toCheck.length > 0) {
    const list = toCheck
      .map(
        (entry) =>
          `  ${entry.key}: ${entry.licence ?? "(none)"} (${entry.judgement.reason})`,
      )
      .join("\n");
    const message =
      `These licences need a look:\n${list}\n` +
      "Read each package's licence. If it's compatible with GPL-3.0-or-later, " +
      "add it to REVIEWED in scripts/notices.mjs with its SPDX id; if not, " +
      "replace the package.";
    if (strict) throw new Error(message);
    console.warn(`notices: ${message}`);
  }
}

// ------------------------------------------------- electron-builder's hook

/**
 * electron-builder calls this after unpacking Electron for each platform and
 * arch, before it copies extraResources (which ships the notices).
 *
 * On macOS it also keeps Electron's licence files. They sit next to
 * Electron.app in Electron's download, and electron-builder deletes them
 * later on macOS (on Windows and Linux it keeps them next to the program).
 * Moved inside the app, they ship with it.
 */
export async function afterExtract(context) {
  await writeNotices();
  if (context.electronPlatformName !== "darwin") return;
  const { appOutDir } = context;
  const bundle = (await readdir(appOutDir)).find((name) =>
    name.endsWith(".app"),
  );
  if (!bundle) throw new Error(`notices: no .app in ${appOutDir}`);
  const resources = join(appOutDir, bundle, "Contents", "Resources");
  for (const [from, to] of [
    ["LICENSES.chromium.html", "LICENSES.chromium.html"],
    ["LICENSE", "LICENSE.electron.txt"],
  ]) {
    const source = join(appOutDir, from);
    if (!existsSync(source)) {
      throw new Error(
        `notices: Electron's ${from} is missing from ${appOutDir}`,
      );
    }
    await copyFile(source, join(resources, to));
  }
}

// Run only as a command, not when electron-builder imports this for the hook.
// (`import.meta.main` needs Node 24.2+; the comparison covers older 24.x.)
if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      strict: { type: "boolean", default: false },
    },
  });
  writeNotices({ out: values.out, strict: values.strict }).catch((error) => {
    console.error(`notices: ${error.message}`);
    process.exitCode = 1;
  });
}

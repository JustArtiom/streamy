// Generates every Streamy logo and app icon from one drawing (the "Pieces" mark).
// Run with `npm run icons` after changing anything here. It uses Electron's
// Chromium to turn the SVGs into PNGs, so it needs no extra tools.
//
// Writes:
//   src/renderer/src/assets/logo.svg        in-app logo (title bar)
//   build/icon.icon/                        macOS 26+ icon (Icon Composer format;
//                                            electron-builder compiles it with
//                                            Xcode, which also makes the icon for
//                                            older macOS versions)
//   build/icon.png                           macOS-style icon (Dock icon in dev)
//   build/icon.ico                           Windows
//   build/icons/<size>x<size>.png            Linux

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const ASSETS = join(ROOT, "src/renderer/src/assets");

// Brand colors ("Ember").
const FROM = "#ff8a1f";
const TO = "#ff2d6f";

const r2 = (n) => Math.round(n * 100) / 100;

/**
 * The mark: a play triangle built from torrent pieces, in a 100×100 box.
 * "detailed" has 28 pieces (7 rows); "small" has 6 (3 rows) for tiny sizes.
 */
function pieces(detail, fill) {
  const g =
    detail === "small"
      ? { rows: 3, rowStep: 24, colStep: 21, size: 19, radius: 4.5 }
      : { rows: 7, rowStep: 10, colStep: 9, size: 7.6, radius: 1.9 };
  const x0 = 50 - ((g.rows - 1) * g.colStep) / 2;
  let rects = "";
  for (let col = 0; col < g.rows; col++) {
    for (let row = 0; row < g.rows - col; row++) {
      const cx = x0 + col * g.colStep;
      const cy = 50 - ((g.rows - 1 - col) * g.rowStep) / 2 + row * g.rowStep;
      rects += `<rect x="${r2(cx - g.size / 2)}" y="${r2(cy - g.size / 2)}" width="${g.size}" height="${g.size}" rx="${g.radius}" fill="${fill}"/>`;
    }
  }
  return rects;
}

const gradient = (id, x1, y1, x2, y2, units = "userSpaceOnUse") =>
  `<linearGradient id="${id}" gradientUnits="${units}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${FROM}"/><stop offset="1" stop-color="${TO}"/></linearGradient>`;

/** The mark on its own, in brand colors (used inside the app). */
const logoSvg = (detail) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${gradient("g", 12, 8, 88, 92)}</defs>${pieces(detail, "url(#g)")}</svg>\n`;

/** macOS-style rounded square ("squircle") path for a box at (x, y) of size s. */
function squircle(x, y, s) {
  const points = [];
  for (let i = 0; i < 180; i++) {
    const t = (i / 180) * Math.PI * 2;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    const px = x + s / 2 + (s / 2) * Math.sign(c) * Math.abs(c) ** 0.4;
    const py = y + s / 2 + (s / 2) * Math.sign(sn) * Math.abs(sn) ** 0.4;
    points.push(`${r2(px)} ${r2(py)}`);
  }
  return `M${points.join(" L")}Z`;
}

/**
 * App icon: white mark on a brand-gradient squircle.
 * `inset` is the empty margin around the squircle (macOS leaves ~10% for its
 * shadow; Windows/Linux icons fill almost the whole square).
 */
function appIconSvg({ detail, inset, shadow }) {
  const s = 100 - inset * 2;
  const shape = squircle(inset, inset, s);
  const markSize = s * 0.6;
  const markAt = 50 - markSize / 2;
  const filter = shadow
    ? `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.6" flood-color="#000" flood-opacity="0.3"/></filter>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${gradient("bg", 0, 0, 1, 1, "objectBoundingBox")}<linearGradient id="hl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.28"/><stop offset="0.55" stop-color="#fff" stop-opacity="0"/></linearGradient>${filter}</defs><path d="${shape}" fill="url(#bg)"${shadow ? ' filter="url(#s)"' : ""}/><path d="${shape}" fill="url(#hl)"/><svg x="${r2(markAt)}" y="${r2(markAt)}" width="${r2(markSize)}" height="${r2(markSize)}" viewBox="0 0 100 100">${pieces(detail, "#fff")}</svg></svg>`;
}

/**
 * Icon Composer layer: just the white mark on a 1024 canvas. macOS draws the
 * squircle, the gradient background (icon.json "fill") and the glass effect.
 */
const iconComposerLayerSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><g transform="translate(20 20) scale(0.6)">${pieces("detailed", "#fff")}</g></svg>\n`;

function srgb(hex) {
  const v = [1, 3, 5].map((i) =>
    (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5),
  );
  return `srgb:${v.join(",")},1.00000`;
}

const iconComposerJson = {
  fill: {
    "linear-gradient": [srgb(FROM), srgb(TO)],
    orientation: { start: { x: 0, y: 0 }, stop: { x: 1, y: 1 } },
  },
  groups: [
    {
      layers: [{ "image-name": "pieces.svg", name: "pieces", glass: true }],
      shadow: { kind: "neutral", opacity: 0.5 },
      // Solid white pieces: see-through glass washes them out at small sizes.
      translucency: { enabled: false, value: 0.5 },
    },
  ],
  "supported-platforms": { squares: "shared" },
};

/** Builds a Windows .ico from PNGs (PNG-in-ICO, supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;
  images.forEach(({ size, png }, i) => {
    const at = i * 16;
    entries.writeUInt8(size >= 256 ? 0 : size, at); // 0 means 256
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1);
    entries.writeUInt16LE(1, at + 4); // color planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(png.length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map((image) => image.png)]);
}

/** SVG → PNG at an exact pixel size, drawn by Chromium. */
async function rasterize(window, jobs) {
  const results = await window.webContents.executeJavaScript(`
    Promise.all(${JSON.stringify(jobs)}.map(async ({ svg, size }) => {
      const image = new Image();
      image.src = "data:image/svg+xml;base64," + btoa(svg);
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(image, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }))
  `);
  return results.map((base64) => Buffer.from(base64, "base64"));
}

// Small icons use the 6-piece mark so they stay crisp.
const detailFor = (size) => (size <= 32 ? "small" : "detailed");

async function main() {
  const window = new BrowserWindow({ show: false });
  await window.loadURL("about:blank");

  // In-app logo
  await mkdir(ASSETS, { recursive: true });
  await writeFile(join(ASSETS, "logo.svg"), logoSvg("detailed"));

  // macOS: Icon Composer package + a PNG for the Dock while developing
  const iconDir = join(BUILD, "icon.icon");
  await rm(iconDir, { recursive: true, force: true });
  await mkdir(join(iconDir, "Assets"), { recursive: true });
  await writeFile(join(iconDir, "Assets/pieces.svg"), iconComposerLayerSvg());
  await writeFile(
    join(iconDir, "icon.json"),
    JSON.stringify(iconComposerJson, null, 2) + "\n",
  );
  const [macPng] = await rasterize(window, [
    {
      svg: appIconSvg({ detail: "detailed", inset: 10, shadow: true }),
      size: 1024,
    },
  ]);
  await writeFile(join(BUILD, "icon.png"), macPng);

  // Windows + Linux: the squircle fills almost the whole square
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 256];
  const linuxSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const sizes = [...new Set([...icoSizes, ...linuxSizes])];
  const pngs = await rasterize(
    window,
    sizes.map((size) => ({
      svg: appIconSvg({
        detail: detailFor(size),
        inset: size <= 32 ? 1 : 3,
        shadow: false,
      }),
      size,
    })),
  );
  const pngBySize = new Map(sizes.map((size, i) => [size, pngs[i]]));

  await writeFile(
    join(BUILD, "icon.ico"),
    ico(icoSizes.map((size) => ({ size, png: pngBySize.get(size) }))),
  );
  const linuxDir = join(BUILD, "icons");
  await rm(linuxDir, { recursive: true, force: true });
  await mkdir(linuxDir, { recursive: true });
  for (const size of linuxSizes) {
    await writeFile(join(linuxDir, `${size}x${size}.png`), pngBySize.get(size));
  }

  console.log("Icons written to build/ and src/renderer/src/assets/");
}

app.dock?.hide();
app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    app.quit();
  });

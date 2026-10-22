import { describe, expect, it } from "vitest";

// Vitest swaps CSS imports for empty ones (even "?raw"), so the file is read
// from disk. The UI's tsconfig has no Node.js types: hence this shape.
type NodeFs = {
  readFileSync: (path: string, encoding: "utf8") => string;
};
const { process } = globalThis as unknown as {
  process: {
    cwd: () => string;
    getBuiltinModule: (id: "node:fs") => NodeFs;
  };
};
// Vitest runs from the app's folder (vitest.config.mts).
const css = process
  .getBuiltinModule("node:fs")
  .readFileSync(`${process.cwd()}/src/renderer/src/index.css`, "utf8");

// The color tokens in index.css, checked against WCAG 2.2 contrast minimums
// in both themes: 4.5:1 for text, 3:1 for what's needed to see a control
// and its state (focus rings, a switch's track and thumb, icons).

type Rgba = [number, number, number, number];
type Theme = "light" | "dark";

function parseColor(text: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(text.trim());
  if (hex?.[1]) {
    const value = hex[1];
    const channel = (i: number) => Number.parseInt(value.slice(i, i + 2), 16);
    return [channel(0), channel(2), channel(4), 1];
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(text.trim());
  if (rgb) {
    return [
      Number(rgb[1]),
      Number(rgb[2]),
      Number(rgb[3]),
      rgb[4] === undefined ? 1 : Number(rgb[4]),
    ];
  }
  throw new Error(`Can't read the color ${text}`);
}

/** A token's value in one theme: `--name: light-dark(<light>, <dark>)`. */
function token(name: string, theme: Theme): Rgba {
  const match = new RegExp(
    `--${name}:\\s*light-dark\\((#[0-9a-f]{6}|rgb\\([^)]*\\)),\\s*(#[0-9a-f]{6}|rgb\\([^)]*\\))\\)`,
    "i",
  ).exec(css);
  const value = theme === "light" ? match?.[1] : match?.[2];
  if (!value) throw new Error(`No --${name} in index.css`);
  return parseColor(value);
}

/** `color` at `alpha` over an opaque `background`. */
function over(color: Rgba, background: Rgba, alpha = color[3]): Rgba {
  const mix = (i: 0 | 1 | 2) => color[i] * alpha + background[i] * (1 - alpha);
  return [mix(0), mix(1), mix(2), 1];
}

function luminance([r, g, b]: Rgba) {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe.each<Theme>(["light", "dark"])("the %s theme", (theme) => {
  const background = token("background", theme);
  const accent = token("accent", theme);

  // Badges: text in the tone's color on a 12% tint of it (badge.tsx).
  it.each(["success", "info", "danger"])(
    "has readable %s text, even on its own tint",
    (tone) => {
      const color = token(tone, theme);
      const badge = over(color, background, 0.12);
      expect(contrast(color, badge)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("has warning icons that stand out from a warning banner", () => {
    const warning = token("warning", theme);
    expect(
      contrast(warning, over(warning, background, 0.08)),
    ).toBeGreaterThanOrEqual(3);
  });

  it("has focus rings that stand out from the page and hover colors", () => {
    const ring = token("ring", theme);
    expect(contrast(over(ring, background), background)).toBeGreaterThanOrEqual(
      3,
    );
    expect(contrast(over(ring, accent), accent)).toBeGreaterThanOrEqual(3);
  });

  it("shows a switch that's off: its track, and the thumb on it", () => {
    const track = token("switch-off", theme);
    expect(contrast(track, background)).toBeGreaterThanOrEqual(3);
    // The thumb is the background color.
    expect(contrast(background, track)).toBeGreaterThanOrEqual(3);
  });
});

describe("window dragging", () => {
  // Electron finds drag regions in the layout, whatever is on top: under a
  // modal's backdrop, pressing the title bar would drag the window instead
  // of closing the dialog.
  it("is off while a modal dialog is open", () => {
    expect(css).toMatch(
      /:root:has\(dialog:modal\)\s+\.drag-region\s*\{[^}]*app-region:\s*no-drag/,
    );
  });
});

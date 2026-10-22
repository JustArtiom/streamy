import { expect, type Locator, type Page } from "@playwright/test";
import { CUE_SECONDS } from "./media";

// The player page (/watch/…), as people use it. Times are movie seconds.

export function player(page: Page): Locator {
  return page.getByTestId("player");
}

/** Where the movie is: the timeline's value (whole seconds). */
export async function movieTime(page: Page): Promise<number> {
  const value = await player(page)
    .getByRole("slider", { name: "Seek" })
    .getAttribute("aria-valuenow");
  return Number(value);
}

/**
 * Waits until the video has played on from `from`: the timeline shows at
 * least `from + 2` (a pending seek already shows its target, so reaching
 * past it means frames really played), and not far beyond `from` (it didn't
 * start somewhere else). Returns how long that took.
 */
export async function expectPlaysFrom(
  page: Page,
  from: number,
  { timeout = 20_000, slack = 12 }: { timeout?: number; slack?: number } = {},
): Promise<number> {
  const started = Date.now();
  await expect
    .poll(() => movieTime(page), {
      message: `The video should play on from ${from} s`,
      timeout,
    })
    .toBeGreaterThanOrEqual(from + 2);
  expect(await movieTime(page)).toBeLessThan(from + slack);
  return Date.now() - started;
}

/** The controls hide while the video plays: a mouse move brings them back. */
export async function revealControls(page: Page): Promise<void> {
  const box = await player(page).boundingBox();
  if (!box) throw new Error("The player isn't on screen");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3);
}

/**
 * Clicks one of the player's buttons (Turn subtitles on, Settings, …). The
 * controls fade 3 s after the mouse stops: if they hid before the click
 * could land, they're brought back and it's tried again. (A click that
 * timed out never happened, so trying again is safe.)
 */
export async function clickControl(page: Page, name: string): Promise<void> {
  const button = player(page).getByRole("button", { name, exact: true });
  await expect(async () => {
    await revealControls(page);
    await button.click({ timeout: 2_000 });
  }).toPass();
}

/** Opens the player's settings menu. */
export async function openPlayerMenu(page: Page): Promise<Locator> {
  await clickControl(page, "Settings");
  const menu = page.getByRole("menu", { name: "Player settings" });
  await expect(menu).toBeVisible();
  return menu;
}

/** Settings → <row> → <choice>, e.g. ("Quality", "360p"). The menu closes. */
export async function choose(
  page: Page,
  row: "Quality" | "Audio" | "Subtitles",
  choice: string | RegExp,
): Promise<void> {
  const menu = await openPlayerMenu(page);
  await menu.getByRole("menuitem", { name: new RegExp(`^${row}`) }).click();
  await menu.getByRole("menuitemradio", { name: choice }).click();
  await expect(menu).toBeHidden();
}

/** What a row of the settings menu shows now ("Audio" → "German · Mono"). */
export async function menuValue(
  page: Page,
  row: "Quality" | "Audio" | "Subtitles",
): Promise<string> {
  const menu = await openPlayerMenu(page);
  const text = await menu
    .getByRole("menuitem", { name: new RegExp(`^${row}`) })
    .innerText();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return text.replace(row, "").trim();
}

/** Turns on "Stats for nerds" (it stays open after the menu closes). */
export async function showStats(page: Page): Promise<void> {
  const menu = await openPlayerMenu(page);
  await menu.getByRole("menuitemcheckbox", { name: "Stats for nerds" }).click();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(statsValue(page, "Mode")).toBeVisible();
}

/** A line of the stats panel: "Mode" → "direct — …". */
export function statsValue(page: Page, label: string): Locator {
  return player(page).locator(`dt:text-is("${label}") + dd`);
}

/** The subtitle line on screen. */
export function subtitleLine(page: Page): Locator {
  return page.getByTestId("subtitles");
}

/**
 * The subtitle shown is the one for the current time: the test videos' cue
 * N covers [2N, 2N + 2) seconds and says "<prefix> N".
 */
export async function expectSubtitleInSync(
  page: Page,
  prefix: string,
): Promise<void> {
  const line = subtitleLine(page);
  await expect(line).toHaveText(new RegExp(`^${prefix} \\d+$`));
  const text = await line.innerText();
  const time = await movieTime(page);
  const cue = Number(/\d+$/.exec(text)?.[0]);
  // Reading the line and the time isn't one atomic step: allow a cue or so.
  expect(Math.abs(cue * CUE_SECONDS - time)).toBeLessThanOrEqual(
    CUE_SECONDS + 1,
  );
}

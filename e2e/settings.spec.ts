import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import type { CacheInfo } from "../src/shared/engine-api";
import { expect, test } from "./fixtures";
import type { StreamyApp } from "./support/app";
import { openSettings } from "./support/ui";

/** settings.json as main saved it. */
function savedSettings(app: StreamyApp): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(app.workspace.settingsFile, "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {}; // Not written yet.
  }
}

async function cacheLimit(app: StreamyApp): Promise<number | null> {
  const { body } = await app.api<CacheInfo>("/v1/cache");
  return body.limitBytes;
}

/** The engine's own "Settings changed" log lines: what it was told. */
function engineChanges(app: StreamyApp): string[] {
  return app
    .logLines("engine.log")
    .filter((line) => line.msg === "Settings changed")
    .flatMap((line) => line.changed as string[]);
}

/**
 * Picks a number in a settings <select> other than the one chosen now (the
 * lists of choices may change; any other one will do). Returns it.
 */
async function chooseAnotherNumber(select: Locator): Promise<number> {
  const current = await select.inputValue();
  const values = await select
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
  const other = values.find(
    (value) => /^\d+$/.test(value) && value !== current,
  );
  if (other === undefined) throw new Error("No other number to choose");
  await select.selectOption(other);
  return Number(other);
}

test("storage and network settings are saved and reach the engine", async ({
  launch,
}) => {
  const app = await launch();

  const storage = await openSettings(app.page, "Storage");
  const gigabytes = await chooseAnotherNumber(
    storage.getByRole("combobox", { name: "Size limit" }),
  );
  await expect.poll(() => savedSettings(app).cacheLimitGb).toBe(gigabytes);
  // The engine counts 1 GB as 10⁹ bytes, like the sizes the UI shows.
  await expect.poll(() => cacheLimit(app)).toBe(gigabytes * 1e9);

  const network = await openSettings(app.page, "Network");
  const download = await chooseAnotherNumber(
    network.getByRole("combobox", { name: "Download limit" }),
  );
  const upload = await chooseAnotherNumber(
    network.getByRole("combobox", { name: "Upload limit" }),
  );
  const connections = await chooseAnotherNumber(
    network.getByRole("combobox", { name: "Max connections" }),
  );
  await expect
    .poll(() => {
      const { downloadLimitKBps, uploadLimitKBps, maxConnections } =
        savedSettings(app);
      return { downloadLimitKBps, uploadLimitKBps, maxConnections };
    })
    .toEqual({
      downloadLimitKBps: download,
      uploadLimitKBps: upload,
      maxConnections: connections,
    });
  await expect
    .poll(() => engineChanges(app))
    .toEqual(
      expect.arrayContaining([
        "cacheLimitBytes",
        "downloadLimit",
        "uploadLimit",
        "maxConnections",
      ]),
    );

  // A new engine gets them from the start (in its init message).
  await app.close();
  const relaunched = await launch();
  expect(await cacheLimit(relaunched)).toBe(gigabytes * 1e9);
});

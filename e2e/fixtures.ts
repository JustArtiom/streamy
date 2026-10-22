import { join } from "node:path";
import { test as base, type TestInfo } from "@playwright/test";
import { killLeftovers, StreamyApp } from "./support/app";
import { mediaDir } from "./support/media";
import { type Seeder, startSeeder } from "./support/seeder";
import {
  createWorkspace,
  removeWorkspace,
  type Workspace,
} from "./support/workspace";

// What every test gets. All of it is cleaned up after the test, passed or
// failed: apps quit (and their processes are checked to be gone), the
// seeder stops, the workspace folder is deleted.
//
//   workspace  a throwaway folder: the profile, logs, videos (workspace.ts)
//   launch()   starts Streamy on the workspace; call again to relaunch
//              (same profile) after closing the first one
//   app        the first launch, for tests that need only one
//   seeder     shares the test videos on 127.0.0.1 (seeder.ts); set
//              `test.use({ seederUploadLimit })` for a slow one

type Options = {
  /** Bytes per second the seeder shares at; null = as fast as it can. */
  seederUploadLimit: number | null;
};

type Fixtures = {
  workspace: Workspace;
  launch: () => Promise<StreamyApp>;
  app: StreamyApp;
  seeder: Seeder;
};

const failed = (testInfo: TestInfo) =>
  testInfo.status !== testInfo.expectedStatus;

export const test = base.extend<Options & Fixtures>({
  seederUploadLimit: [null, { option: true }],

  // eslint-disable-next-line no-empty-pattern -- Playwright needs the braces.
  workspace: async ({}, use, testInfo) => {
    const workspace = await createWorkspace();
    await use(workspace);
    if (failed(testInfo)) await attachLogs(workspace, testInfo);
    await removeWorkspace(workspace);
  },

  launch: async ({ workspace }, use, testInfo) => {
    const apps: StreamyApp[] = [];
    await use(async () => {
      const app = await StreamyApp.launch(
        workspace,
        testInfo,
        String(apps.length + 1),
      );
      apps.push(app);
      return app;
    });

    const problems: unknown[] = [];
    for (const [index, app] of apps.entries()) {
      const name = `launch ${index + 1}`;
      if (failed(testInfo) && !app.closed) {
        const screenshot = await app.page
          .screenshot({ timeout: 5_000 })
          .catch(() => null);
        if (screenshot) {
          await testInfo.attach(`screenshot (${name})`, {
            body: screenshot,
            contentType: "image/png",
          });
        }
      }
      await app.close().catch((error: unknown) => problems.push(error));
      if (failed(testInfo)) {
        await testInfo
          .attach("trace", {
            path: app.tracePath,
            contentType: "application/zip",
          })
          .catch(() => undefined);
        await testInfo.attach(`electron output (${name})`, {
          body: app.output(),
          contentType: "text/plain",
        });
      }
    }
    // Belt and braces: anything still running from this workspace.
    const leftovers = await killLeftovers(workspace.root);
    if (leftovers.length > 0) {
      problems.push(
        new Error(
          `Killed processes left behind: ${leftovers.map(({ pid }) => pid).join(", ")}`,
        ),
      );
    }
    if (problems.length > 0) throw problems[0];
  },

  app: async ({ launch }, use) => {
    await use(await launch());
  },

  seeder: async ({ seederUploadLimit }, use) => {
    const seeder = await startSeeder(mediaDir(), {
      uploadLimit: seederUploadLimit,
    });
    await use(seeder);
    await seeder.stop();
  },
});

export { expect } from "@playwright/test";

/** main.log and engine.log of a failed test, for the report. */
async function attachLogs(workspace: Workspace, testInfo: TestInfo) {
  for (const file of ["main.log", "engine.log"]) {
    await testInfo
      .attach(file, {
        path: join(workspace.logs, file),
        contentType: "text/plain",
      })
      .catch(() => undefined); // Not written (the app never started).
  }
}

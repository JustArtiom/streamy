import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { APP_DIR, BUILD_DIR, BUILD_MAIN } from "./paths";

const run = promisify(execFile);

/**
 * Builds the app into .e2e/build/out (not app/out, which `npm start` uses),
 * plus the package.json Electron reads: the app's own name and version, and
 * `main` pointing at that build. Electron then finds the preload, the UI and
 * the engine next to main's bundle, and node_modules in app/.
 *
 * E2E_SKIP_BUILD=1 reuses an existing build (to iterate on the tests
 * themselves). Without one, it builds anyway.
 */
export async function buildApp(): Promise<{ built: boolean }> {
  if (process.env.E2E_SKIP_BUILD && existsSync(BUILD_MAIN)) {
    return { built: false };
  }

  const cli = join(
    APP_DIR,
    "node_modules",
    "electron-vite",
    "bin",
    "electron-vite.js",
  );
  await run(
    process.execPath,
    [cli, "build", "--outDir", join(BUILD_DIR, "out")],
    { cwd: APP_DIR, maxBuffer: 64 * 1024 * 1024 },
  );

  const pkg = JSON.parse(
    readFileSync(join(APP_DIR, "package.json"), "utf8"),
  ) as { name: string; productName: string; version: string };
  const manifest = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    type: "module",
    main: "out/main/index.js",
  };
  await writeFile(
    join(BUILD_DIR, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { built: true };
}

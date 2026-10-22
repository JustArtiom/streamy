import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * electron-vite makes the UI's asset URLs relative ("./assets/…") in
 * production. The UI is a single-page app: after a reload on a route like
 * app://streamy/torrent/abc, "./assets/x.js" would point into /torrent/.
 * Absolute URLs ("/assets/x.js") work from every route.
 */
function absoluteAssetUrls(): Plugin {
  return {
    name: "streamy:absolute-asset-urls",
    config(config) {
      config.base = "/";
    },
  };
}

// Three builds: main (Node side, which also bundles the engine), preload
// (the bridge) and renderer (the UI).
export default defineConfig({
  // ESM ("type": "module" in package.json). The engine is built from main's
  // `?modulePath` import (src/main/engine/entry.ts) with the same settings.
  main: {},
  preload: {
    build: {
      rolldownOptions: {
        // A sandboxed preload can't be an ES module: Electron runs it as one
        // plain script. ".cjs" so Node never mistakes it for ESM either.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer/src") },
    },
    plugins: [react(), tailwindcss(), absoluteAssetUrls()],
    build: {
      // electron-vite leaves the UI unminified; minified, it's about a third
      // of the size and the window starts faster. (Main and preload stay
      // readable: small, and their stack traces end up in main.log.)
      minify: "oxc",
      // Vite's 500 kB warning is about downloads; the UI loads from disk.
      // (The player, with hls.js, is its own chunk already.)
      chunkSizeWarningLimit: 1_000,
    },
  },
});

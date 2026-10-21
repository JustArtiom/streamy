import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["tree"],
    restoreMocks: true,
    projects: [
      {
        // Main-process logic: plain Node.js, no Electron needed.
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["src/main/**/*.test.ts"],
        },
      },
      {
        // The UI: a fake DOM, and a fake window.streamy (src/renderer/src/test).
        extends: true,
        resolve: {
          alias: { "@": resolve(import.meta.dirname, "src/renderer/src") },
        },
        test: {
          name: "renderer",
          environment: "jsdom",
          include: ["src/renderer/**/*.test.{ts,tsx}"],
          setupFiles: ["src/renderer/src/test/setup.ts"],
        },
      },
    ],
  },
});

import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: ["tree"],
    restoreMocks: true,
    projects: [
      {
        // Node.js side: the main process and the engine. Plain Node.js, no
        // Electron needed (Electron is faked where it's used).
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "src/main/**/*.test.ts",
            "src/engine/**/*.test.ts",
            "src/shared/**/*.test.ts",
          ],
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

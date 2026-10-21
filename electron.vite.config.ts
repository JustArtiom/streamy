import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Three builds: main (Node side), preload (the bridge) and renderer (the UI).
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: { "@": resolve("src/renderer/src") },
    },
    plugins: [react(), tailwindcss()],
  },
});

/// <reference types="electron-vite/node" />

// The engine's entry file. electron-vite builds src/engine/index.ts as a
// second ES module next to main's bundle (out/main/chunks/…), and this
// import gives its path on disk: inside app.asar once installed.
// Kept in its own file: tests import the host, never this.
import enginePath from "../../engine/index?modulePath";

export const ENGINE_ENTRY: string = enginePath;

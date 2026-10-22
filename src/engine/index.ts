import { type ParentPortLike, runEngineProcess, startEngine } from "./engine";
import { logger } from "./lib/logger";
import { testModeOverrides } from "./test-mode";
import { setTorrentClientOptionsForTests } from "./torrents/client";

/*
 * The engine's entry point: Electron starts this file as a utilityProcess
 * (main's src/main/engine/host.ts). Everything else in src/engine can be
 * imported without side effects; this file is the only one that starts
 * anything.
 */

// Electron's types declare parentPort on every process, but it only exists
// in a utility process: plain Node (or a test) has none.
const parentPort = (process as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  // STREAMY_TEST_MODE=1 (the e2e tests): local peers only (test-mode.ts).
  const testMode = testModeOverrides();
  if (testMode) setTorrentClientOptionsForTests(testMode.clientOptions);

  const { fatal } = runEngineProcess(parentPort, {
    start: async (init, transport) => {
      const engine = await startEngine(init, transport, {
        tuning: testMode?.tuning,
      });
      // In engine.log, so the e2e tests can see the engine got the variable.
      if (testMode) logger.info("Test mode: local peers only");
      return engine;
    },
  });

  // A bug somewhere: the engine's state can't be trusted anymore. Say so
  // and exit; main restarts it.
  process.on("uncaughtException", (error) => {
    fatal(`Unexpected error: ${error.message}`, error);
  });
  // A stray promise (WebTorrent has a few): log it, keep serving.
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "Unhandled promise rejection");
  });
} else {
  process.stderr.write(
    "The Streamy engine runs inside Streamy (an Electron utility process).\n",
  );
  process.exitCode = 1;
}

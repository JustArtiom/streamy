// STREAMY_TEST_MODE=1: the end-to-end tests (e2e/) drive the real app with
// Playwright. In test mode Streamy must never show up on the desktop of the
// person running them, nor change anything outside its own --user-data-dir:
// - windows are created hidden, never shown, and muted (window.ts);
// - no Dock icon, no focus stealing, no update checks (index.ts);
// - no login item, no magnet: handler (system-integration.ts);
// - the engine stays off the internet: no public trackers, no DHT, no LSD,
//   no port mapping (src/engine/test-mode.ts reads the same variable: the
//   engine's utilityProcess inherits main's environment).
// Like the smoke test, it refuses to run without --user-data-dir.
//
// This file is the only place main reads the variable.

/** True when the e2e tests started this copy of Streamy. */
export function isTestMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STREAMY_TEST_MODE === "1";
}

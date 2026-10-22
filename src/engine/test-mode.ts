import type { ClientOptions } from "webtorrent";
import type { Tuning } from "./config";

/*
 * STREAMY_TEST_MODE=1: the end-to-end tests (e2e/) run the real app against
 * a WebTorrent seeder on 127.0.0.1, named in the magnet (x.pe). The engine
 * must not reach anyone else: no public trackers added to torrents, no DHT,
 * no local peer discovery (LSD), no peer exchange, no port mapping on the
 * router (UPnP / NAT-PMP), no web seeds. Peers on 127.0.0.1 are allowed
 * (a normal run drops them from magnets: lib/local-address.ts).
 *
 * The variable comes from main's environment: Electron's utilityProcess
 * inherits it (main never sets it; see src/main/test-mode.ts). This is the
 * only place the engine reads it.
 */

/** WebTorrent options that keep the client to the peers it's given. */
export const OFFLINE_CLIENT_OPTIONS = {
  dht: false,
  tracker: false,
  lsd: false,
  utPex: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
} as const satisfies ClientOptions;

export type TestModeOverrides = {
  clientOptions: ClientOptions;
  tuning: Partial<Tuning>;
};

/** What test mode changes, or null when it's off (a normal run). */
export function testModeOverrides(
  env: NodeJS.ProcessEnv = process.env,
): TestModeOverrides | null {
  if (env.STREAMY_TEST_MODE !== "1") return null;
  return {
    clientOptions: { ...OFFLINE_CLIENT_OPTIONS },
    // No public trackers in the torrents either (or in the library's copy).
    tuning: { trackers: [], allowLocalAddresses: true },
  };
}

import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OFFLINE_CLIENT_OPTIONS } from "../test-mode";
import { useTestRuntime } from "../test/runtime";
import {
  destroyTorrentClient,
  getTorrentClient,
  resetTorrentClientForTests,
  setTorrentClientOptionsForTests,
} from "./client";
import { setInternalOrigin } from "./file-tokens";
import { pauseDownloads, releaseAllTorrents, torrentService } from "./service";

/*
 * "Disk almost full" pauses downloading for longer than WebTorrent's
 * timeouts (30 s for an answer, 25 s for a handshake): the torrent must
 * keep, or get back, its peer and go on downloading once resumed. A real
 * seeder on 127.0.0.1, no internet.
 *
 * Opt-in (about 90 s):  STREAMY_E2E=1 npx vitest run src/engine/torrents/pause.e2e.test.ts
 */

const enabled = process.env.STREAMY_E2E === "1";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(enabled)("pausing downloads with a real peer", () => {
  let base: string;
  let seeder: WebTorrent;
  let seeded: Torrent;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    ({ cleanup } = await useTestRuntime({
      allowLocalAddresses: true,
      trackers: [],
    }));
    setInternalOrigin("http://127.0.0.1:4321");
    base = await mkdtemp(join(tmpdir(), "streamy-pause-"));
    await writeFile(join(base, "movie.bin"), randomBytes(16 * 1024 * 1024));
    // Slow, so requests are always outstanding when downloads pause.
    seeder = new WebTorrent({
      ...OFFLINE_CLIENT_OPTIONS,
      utp: false,
      uploadLimit: 200_000,
    });
    seeded = await new Promise<Torrent>((resolve) => {
      seeder.seed(join(base, "movie.bin"), { announce: [] }, resolve);
    });
    await vi.waitFor(() => {
      expect(seeder.torrentPort).toBeGreaterThan(0);
    });
    setTorrentClientOptionsForTests(OFFLINE_CLIENT_OPTIONS);
  }, 60_000);

  afterAll(async () => {
    pauseDownloads(false);
    releaseAllTorrents();
    await destroyTorrentClient();
    resetTorrentClientForTests();
    await new Promise<void>((resolve) => {
      seeder.destroy(() => {
        resolve();
      });
    });
    setInternalOrigin(null);
    await cleanup();
    await rm(base, { recursive: true, force: true });
  });

  it("downloads again after a 70 s pause", { timeout: 150_000 }, async () => {
    const magnet = `magnet:?xt=urn:btih:${seeded.infoHash}&x.pe=127.0.0.1:${seeder.torrentPort}`;
    await torrentService.add({ magnet });
    await vi.waitFor(
      () => {
        expect(torrentService.get(seeded.infoHash).status).toBe("ready");
      },
      { timeout: 20_000 },
    );
    const torrent = getTorrentClient().torrents[0];
    if (!torrent) throw new Error("No torrent");
    // The player reads the file: its pieces are wanted.
    const stream = torrentService
      .getFile(seeded.infoHash, 0)
      .createReadStream();
    stream.resume();
    await sleep(3000);
    expect(torrent.numPeers).toBe(1);

    pauseDownloads(true);
    await sleep(70_000);
    const paused = torrent.downloaded;
    pauseDownloads(false);

    await vi.waitFor(
      () => {
        expect(torrent.numPeers).toBe(1);
        expect(torrent.downloaded).toBeGreaterThan(paused + 256 * 1024);
      },
      { timeout: 30_000, interval: 500 },
    );
    stream.destroy();
  });
});

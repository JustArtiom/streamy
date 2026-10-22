import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  thumbnailUrl,
  toContinueWatchingItem,
  toFileProgress,
  toLibrary,
  toLibraryTorrent,
  toLibraryTorrentDetail,
} from "./mappers";
import { openInMemoryLibrary } from "./sqlite-library";
import type {
  ContinueWatchingEntry,
  ProgressEntry,
  TorrentEntry,
} from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const JAN_1 = Date.UTC(2026, 0, 1);

const torrent: TorrentEntry = {
  infoHash: A,
  name: "Sintel",
  magnet: "magnet:?xt=urn:btih:secret",
  totalSize: 1000,
  hasMetadata: true,
  addedAt: JAN_1,
  lastOpenedAt: JAN_1 + 1000,
};

const fileProgress: ProgressEntry = {
  infoHash: A,
  fileIndex: 2,
  fileName: "Sintel.mp4",
  position: 600,
  duration: null,
  audioTrack: 1,
  subtitle: "embedded:0",
  watched: false,
  updatedAt: JAN_1 + 2000,
};

const continueWatching: ContinueWatchingEntry = {
  ...fileProgress,
  torrentName: "Sintel",
};

describe("mappers", () => {
  it("turn a torrent into the API's LibraryTorrent, without the magnet", () => {
    expect(toLibraryTorrent(torrent, true)).toStrictEqual({
      infoHash: A,
      name: "Sintel",
      size: 1000,
      addedAt: "2026-01-01T00:00:00.000Z",
      lastOpenedAt: "2026-01-01T00:00:01.000Z",
      active: true,
    });
  });

  it("turn a saved position into the API's FileProgress", () => {
    expect(toFileProgress(fileProgress)).toStrictEqual({
      infoHash: A,
      fileIndex: 2,
      fileName: "Sintel.mp4",
      position: 600,
      duration: null,
      audioTrack: 1,
      subtitle: "embedded:0",
      watched: false,
      updatedAt: "2026-01-01T00:00:02.000Z",
    });
  });

  it("add the torrent's name and thumbnail to a Continue watching item", () => {
    expect(
      toContinueWatchingItem(continueWatching, thumbnailUrl(A, 2)),
    ).toStrictEqual({
      ...toFileProgress(fileProgress),
      torrentName: "Sintel",
      thumbnailUrl: `/v1/library/${A}/files/2/thumbnail`,
    });
  });

  it("build GET /v1/library, asking the engine what only it knows", () => {
    const isActive = vi.fn((infoHash: string) => infoHash === A);
    const thumbnailUrlFor = vi.fn(() => null);

    const library = toLibrary(
      {
        continueWatching: [continueWatching],
        recent: [torrent, { ...torrent, infoHash: B }],
      },
      { isActive, thumbnailUrlFor },
    );

    expect(library.recent.map((item) => item.active)).toEqual([true, false]);
    expect(library.continueWatching[0]?.thumbnailUrl).toBeNull();
    expect(thumbnailUrlFor).toHaveBeenCalledWith(continueWatching);
  });

  it("build GET /v1/library/:infoHash", () => {
    expect(
      toLibraryTorrentDetail(torrent, [fileProgress], false),
    ).toStrictEqual({
      torrent: toLibraryTorrent(torrent, false),
      progress: [toFileProgress(fileProgress)],
    });
  });
});

describe("from the library to the API", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "streamy-mappers-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("fits together", () => {
    const store = openInMemoryLibrary({
      logger: { info: vi.fn(), warn: vi.fn() },
      now: () => JAN_1,
      thumbnailsDir: dir,
    });
    store.recordTorrent({ infoHash: A, name: "Sintel" });
    store.saveProgress({
      infoHash: A,
      fileIndex: 0,
      fileName: "Sintel.mp4",
      position: 120,
      duration: 888,
    });

    const library = toLibrary(
      {
        continueWatching: store.listContinueWatching(),
        recent: store.listRecent(),
      },
      { isActive: () => false, thumbnailUrlFor: () => null },
    );
    store.close();

    expect(library).toStrictEqual({
      continueWatching: [
        {
          infoHash: A,
          fileIndex: 0,
          fileName: "Sintel.mp4",
          position: 120,
          duration: 888,
          audioTrack: null,
          subtitle: null,
          watched: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
          torrentName: "Sintel",
          thumbnailUrl: null,
        },
      ],
      recent: [
        {
          infoHash: A,
          name: "Sintel",
          size: null,
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          active: false,
        },
      ],
    });
  });
});

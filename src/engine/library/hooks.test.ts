import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlaybackHeartbeatEvent } from "../media/playback";
import type { ThumbnailMaker } from "../media/thumbnails";
import type { TorrentMetadataEvent, TorrentRemoval } from "../torrents/service";
import { connectLibrary, type LibrarySources } from "./hooks";
import { LATEST_VERSION } from "./migrations";
import { LIBRARY_FILE, openEngineLibrary } from "./open";
import { openInMemoryLibrary } from "./sqlite-library";
import type { LibraryStore, ProgressEntry } from "./types";

const A = "a".repeat(40);
const METADATA = Buffer.from("d4:infod4:name4:Clipee");

/** Stand-ins for torrentService / playbackService: tests fire their events. */
class FakeSources implements LibrarySources {
  metadata = new Set<(event: TorrentMetadataEvent) => void>();
  removed = new Set<(infoHash: string, removal: TorrentRemoval) => void>();
  heartbeats = new Set<(event: PlaybackHeartbeatEvent) => void>();

  onMetadata = (listener: (event: TorrentMetadataEvent) => void) => {
    this.metadata.add(listener);
    return () => this.metadata.delete(listener);
  };
  onRemoved = (
    listener: (infoHash: string, removal: TorrentRemoval) => void,
  ) => {
    this.removed.add(listener);
    return () => this.removed.delete(listener);
  };
  onHeartbeat = (listener: (event: PlaybackHeartbeatEvent) => void) => {
    this.heartbeats.add(listener);
    return () => this.heartbeats.delete(listener);
  };

  fireMetadata(event: Partial<TorrentMetadataEvent> = {}) {
    for (const l of this.metadata) {
      l({
        infoHash: A,
        name: "Clip",
        magnet: `magnet:?xt=urn:btih:${A}`,
        torrentFile: METADATA,
        size: 1000,
        fileCount: 1,
        ...event,
      });
    }
  }
  fireHeartbeat(event: Partial<PlaybackHeartbeatEvent> = {}) {
    for (const l of this.heartbeats) {
      l({
        sessionId: "s",
        infoHash: A,
        fileIndex: 0,
        fileName: "Clip.mp4",
        position: 42,
        duration: 600,
        paused: false,
        audioTrack: 1,
        subtitle: "embedded:0",
        ...event,
      });
    }
  }
  fireRemoved(removal: TorrentRemoval) {
    for (const l of this.removed) l(A, removal);
  }
}

let dir: string;
let library: LibraryStore;
let sources: FakeSources;
let considered: ProgressEntry[];
let forgotten: string[];
let thumbnails: ThumbnailMaker;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "streamy-hooks-"));
  library = openInMemoryLibrary({
    logger: { info: () => undefined, warn: () => undefined },
    thumbnailsDir: join(dir, "thumbnails"),
  });
  sources = new FakeSources();
  considered = [];
  forgotten = [];
  thumbnails = {
    consider: (entry) => considered.push(entry),
    forget: (infoHash) => forgotten.push(infoHash),
    idle: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
});

afterEach(() => {
  library.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("connectLibrary", () => {
  it("records a torrent once its metadata is in", () => {
    const disconnect = connectLibrary(library, thumbnails, sources);

    sources.fireMetadata();

    expect(library.getTorrent(A)).toMatchObject({
      name: "Clip",
      magnet: `magnet:?xt=urn:btih:${A}`,
      totalSize: 1000,
      metadata: METADATA,
    });
    disconnect();
  });

  it("saves every heartbeat's position, tracks and subtitle, then thinks about the thumbnail", () => {
    const disconnect = connectLibrary(library, thumbnails, sources);
    sources.fireMetadata();

    sources.fireHeartbeat();
    sources.fireHeartbeat({ position: 50, subtitle: undefined });

    expect(library.getFileProgress(A, 0)).toMatchObject({
      position: 50,
      duration: 600,
      audioTrack: 1,
      subtitle: "embedded:0", // undefined = keep
    });
    expect(considered.map((e) => e.position)).toEqual([42, 50]);
    disconnect();
  });

  it("never lets a library failure reach the heartbeat", () => {
    const disconnect = connectLibrary(library, thumbnails, sources);

    // Not recorded: saveProgress throws "not_found".
    expect(() => {
      sources.fireHeartbeat();
    }).not.toThrow();
    library.close();
    expect(() => {
      sources.fireHeartbeat();
      sources.fireMetadata();
      sources.fireRemoved({ dataDeleted: true, forget: true });
    }).not.toThrow();
    expect(considered).toEqual([]);
    disconnect();
  });

  it("forgets a torrent only when asked to", () => {
    const disconnect = connectLibrary(library, thumbnails, sources);
    sources.fireMetadata();

    sources.fireRemoved({ dataDeleted: false, forget: false });
    expect(library.getTorrent(A)).not.toBeNull();

    sources.fireRemoved({ dataDeleted: true, forget: true });
    expect(library.getTorrent(A)).toBeNull();
    expect(forgotten).toEqual([A]);
    disconnect();
  });

  it("stops listening when disconnected", () => {
    const disconnect = connectLibrary(library, thumbnails, sources);
    disconnect();

    sources.fireMetadata();

    expect(library.getTorrent(A)).toBeNull();
    expect(sources.metadata.size + sources.heartbeats.size).toBe(0);
  });
});

describe("openEngineLibrary", () => {
  it("opens <dataDir>/library.db", () => {
    const opened = openEngineLibrary(dir);
    expect(opened.persistent).toBe(true);
    expect(opened.thumbnailPath(A, 0)).toBe(
      join(dir, "thumbnails", A, "0.jpg"),
    );
    opened.close();
  });

  it("falls back to memory for a library.db from a newer Streamy, leaving it alone", () => {
    const file = join(dir, LIBRARY_FILE);
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    db.close();

    const opened = openEngineLibrary(dir);

    expect(opened.persistent).toBe(false);
    opened.recordTorrent({ infoHash: A, name: "Clip" });
    expect(opened.listRecent()).toHaveLength(1);
    opened.close();
    const again = new DatabaseSync(file);
    expect(again.prepare("PRAGMA user_version").get()).toEqual({
      user_version: LATEST_VERSION + 1,
    });
    again.close();
  });

  it("falls back to memory when the folder can't be used", () => {
    const notAFolder = join(dir, "file");
    writeFileSync(notAFolder, "");
    const opened = openEngineLibrary(notAFolder);
    expect(opened.persistent).toBe(false);
    opened.close();
  });
});

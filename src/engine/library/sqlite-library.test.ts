import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import pino from "pino";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { LATEST_VERSION } from "./migrations";
import { CONTINUE_WATCHING_LIMIT, RECENT_LIMIT } from "./rules";
import { moveAside, openInMemoryLibrary, openLibrary } from "./sqlite-library";
import {
  LibraryError,
  type LibraryErrorCode,
  type LibraryLogger,
  type LibraryStore,
  type SaveProgressInput,
} from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
/** A different info hash for each number. */
const hash = (n: number) => n.toString(16).padStart(40, "0");
const METADATA = Buffer.from("d4:infod4:name6:Sintelee");

/** Chmod can't take access away on Windows or from root. */
const permissionsWork =
  process.platform !== "win32" && process.getuid?.() !== 0;

let dir: string;
let file: string;
let clock: number;
let logger: {
  info: Mock<LibraryLogger["info"]>;
  warn: Mock<LibraryLogger["warn"]>;
};
let opened: LibraryStore[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "streamy-library-"));
  file = join(dir, "library.db");
  clock = Date.UTC(2026, 0, 1);
  logger = { info: vi.fn(), warn: vi.fn() };
  opened = [];
});

afterEach(() => {
  for (const library of opened) library.close();
  chmodSync(dir, 0o700);
  rmSync(dir, { recursive: true, force: true });
});

function open(path = file): LibraryStore {
  const library = openLibrary(path, { logger, now: () => clock });
  opened.push(library);
  return library;
}

function expectLibraryError(
  action: () => unknown,
  code: LibraryErrorCode,
  field?: string,
): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LibraryError);
  expect(caught).toMatchObject(
    field === undefined ? { code } : { code, field },
  );
}

/** Reads one value with a separate connection, as another program would. */
function peek(path: string, sql: string): unknown {
  const db = new DatabaseSync(path);
  try {
    return Object.values(db.prepare(sql).get() ?? {})[0];
  } finally {
    db.close();
  }
}

const progress = (
  overrides: Partial<SaveProgressInput> = {},
): SaveProgressInput => ({
  infoHash: A,
  fileIndex: 0,
  fileName: "Sintel.mp4",
  position: 600,
  duration: 888,
  ...overrides,
});

describe("openLibrary", () => {
  it("creates its folder and an up-to-date library.db using WAL", () => {
    const nested = join(dir, "a", "b", "library.db");
    open(nested).recordTorrent({ infoHash: A, name: "Sintel" });
    opened.pop()?.close();

    expect(peek(nested, "PRAGMA user_version")).toBe(LATEST_VERSION);
    expect(peek(nested, "PRAGMA journal_mode")).toBe("wal");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: LATEST_VERSION }),
      "Created library.db",
    );
  });

  it("remembers everything across a restart", () => {
    const first = open();
    first.recordTorrent({ infoHash: A, name: "Sintel", metadata: METADATA });
    first.saveProgress(progress());
    first.close();

    const second = open();

    expect(second.persistent).toBe(true);
    expect(second.getTorrent(A)?.metadata).toEqual(METADATA);
    expect(second.getFileProgress(A, 0)?.position).toBe(600);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("takes the engine's pino logger as it is", () => {
    const engineLogger: LibraryLogger = pino({ enabled: false });

    openLibrary(file, { logger: engineLogger }).close();
  });
});

describe("openLibrary with a damaged file", () => {
  it("moves a file that isn't a database aside and starts fresh", () => {
    writeFileSync(file, "this is not a database ".repeat(100));
    writeFileSync(`${file}-wal`, "old log");

    const library = open();

    const backup = `${file}.corrupt-${clock}`;
    expect(readFileSync(backup, "utf8")).toMatch(/^this is not a database/);
    // The fresh database never uses the damaged one's log.
    const wal = `${file}-wal`;
    expect(existsSync(wal) && readFileSync(wal, "utf8")).not.toBe("old log");
    expect(library.listRecent()).toEqual([]);
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    expect(library.getTorrent(A)?.name).toBe("Sintel");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ file, backup }),
      expect.stringContaining("damaged"),
    );
  });

  it("notices damaged pages, not only a damaged header", () => {
    const library = open();
    for (let n = 0; n < 300; n++) {
      library.recordTorrent({ infoHash: hash(n), name: "x".repeat(200) });
    }
    library.close();
    const bytes = readFileSync(file);
    expect(bytes.length).toBeGreaterThan(8 * 4096);
    bytes.fill(0x5a, 2 * 4096, 6 * 4096);
    writeFileSync(file, bytes);

    expect(open().listRecent()).toEqual([]);
    expect(existsSync(`${file}.corrupt-${clock}`)).toBe(true);
  });

  it("moves the sidecar files along with it", () => {
    writeFileSync(file, "damaged");
    writeFileSync(`${file}-wal`, "old log");
    writeFileSync(`${file}-shm`, "old index");

    const backup = moveAside(file, 42);

    expect(backup).toBe(`${file}.corrupt-42`);
    expect(readdirSync(dir).sort()).toEqual([
      "library.db.corrupt-42",
      "library.db.corrupt-42-shm",
      "library.db.corrupt-42-wal",
    ]);
    expect(readFileSync(`${backup}-wal`, "utf8")).toBe("old log");
  });

  it("never overwrites an earlier backup", () => {
    writeFileSync(file, "garbage ".repeat(100));
    open().close();
    writeFileSync(file, "more garbage ".repeat(100));

    open();

    expect(readFileSync(`${file}.corrupt-${clock}`, "utf8")).toMatch(
      /^garbage/,
    );
    expect(readFileSync(`${file}.corrupt-${clock}-2`, "utf8")).toMatch(
      /^more garbage/,
    );
  });
});

describe("openLibrary with a file it must leave alone", () => {
  const corruptBackups = () =>
    readdirSync(dir).filter((name) => name.includes(".corrupt-"));

  it("refuses a file from a newer Streamy, without changing a byte", () => {
    const db = new DatabaseSync(file);
    db.exec(
      `CREATE TABLE future (x); PRAGMA user_version = ${LATEST_VERSION + 1};`,
    );
    db.close();
    const before = readFileSync(file);

    expectLibraryError(() => open(), "newer_version");

    expect(readFileSync(file).equals(before)).toBe(true);
    expect(peek(file, "PRAGMA journal_mode")).toBe("delete");
    expect(corruptBackups()).toEqual([]);
  });

  it("explains when library.db is a folder", () => {
    mkdirSync(file);

    expectLibraryError(() => open(), "unavailable");
    expect(corruptBackups()).toEqual([]);
  });

  it("explains when its folder can't be made", () => {
    writeFileSync(join(dir, "data"), "a file, not a folder");

    expectLibraryError(
      () => open(join(dir, "data", "library.db")),
      "unavailable",
    );
  });

  it.skipIf(!permissionsWork)("keeps a read-only file as it is", () => {
    open().recordTorrent({ infoHash: A, name: "Sintel" });
    opened.pop()?.close();
    chmodSync(file, 0o444);

    expectLibraryError(() => open(), "unavailable");
    // SQLite made its -wal and -shm files read-only too, like library.db.
    for (const name of readdirSync(dir)) chmodSync(join(dir, name), 0o644);
    expect(corruptBackups()).toEqual([]);
    expect(open().getTorrent(A)?.name).toBe("Sintel");
  });
});

describe("openInMemoryLibrary", () => {
  it("works like the real one, but keeps nothing on disk", () => {
    const thumbnailsDir = join(dir, "thumbs");
    const library = openInMemoryLibrary({
      logger,
      now: () => clock,
      thumbnailsDir,
    });
    opened.push(library);

    library.recordTorrent({ infoHash: A, name: "Sintel" });
    library.saveProgress(progress());

    expect(library.persistent).toBe(false);
    expect(library.listContinueWatching()).toHaveLength(1);
    expect(library.thumbnailPath(A, 0)).toBe(join(thumbnailsDir, A, "0.jpg"));
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("recordTorrent", () => {
  it("adds a torrent", () => {
    const entry = open().recordTorrent({
      infoHash: A,
      name: "Sintel",
      magnet: `magnet:?xt=urn:btih:${A}`,
      metadata: METADATA,
      totalSize: 129_241_752,
    });

    expect(entry).toStrictEqual({
      infoHash: A,
      name: "Sintel",
      magnet: `magnet:?xt=urn:btih:${A}`,
      totalSize: 129_241_752,
      hasMetadata: true,
      addedAt: clock,
      lastOpenedAt: clock,
    });
  });

  it("refreshes a known torrent, keeping when it was added", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel (magnet name)" });
    const addedAt = clock;
    clock += 60_000;

    const entry = library.recordTorrent({ infoHash: A, name: "Sintel" });

    expect(entry).toMatchObject({
      name: "Sintel",
      addedAt,
      lastOpenedAt: clock,
    });
    expect(library.listRecent()).toHaveLength(1);
  });

  it("never erases what's known with null or an omitted value", () => {
    const library = open();
    library.recordTorrent({
      infoHash: A,
      name: "Sintel",
      magnet: "magnet:?xt=urn:btih:a",
      metadata: METADATA,
      totalSize: 1000,
    });

    library.recordTorrent({
      infoHash: A,
      name: null,
      magnet: null,
      metadata: null,
      totalSize: null,
    });
    library.recordTorrent({ infoHash: A, name: null });

    expect(library.getTorrent(A)).toMatchObject({
      name: "Sintel",
      magnet: "magnet:?xt=urn:btih:a",
      metadata: METADATA,
      totalSize: 1000,
    });
  });

  it("names a torrent by its info hash until its name is known", () => {
    const library = open();

    expect(library.recordTorrent({ infoHash: A, name: null }).name).toBe(A);
    expect(library.recordTorrent({ infoHash: A, name: "Sintel" }).name).toBe(
      "Sintel",
    );
  });

  it.each([
    ["infoHash", { infoHash: A.toUpperCase() }],
    ["infoHash", { infoHash: "abc" }],
    ["infoHash", { infoHash: `../../${"a".repeat(34)}` }],
    ["name", { name: "" }],
    ["magnet", { magnet: "" }],
    ["metadata", { metadata: new Uint8Array() }],
    ["totalSize", { totalSize: -1 }],
    ["totalSize", { totalSize: 1.5 }],
    ["totalSize", { totalSize: Number.NaN }],
  ])("rejects a bad %s (%j)", (field, overrides) => {
    const library = open();

    expectLibraryError(
      () =>
        library.recordTorrent({ infoHash: A, name: "Sintel", ...overrides }),
      "invalid_input",
      field,
    );
    expect(library.listRecent()).toEqual([]);
  });
});

describe("touchTorrent and getTorrent", () => {
  it("touching moves only lastOpenedAt", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    clock += 5_000;

    expect(library.touchTorrent(A)).toBe(true);
    expect(library.getTorrent(A)).toMatchObject({
      addedAt: clock - 5_000,
      lastOpenedAt: clock,
    });
  });

  it("says when the torrent isn't known", () => {
    const library = open();

    expect(library.touchTorrent(A)).toBe(false);
    expect(library.getTorrent(A)).toBeNull();
  });

  it("returns the metadata as a Buffer, or null when it never arrived", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel", metadata: METADATA });
    library.recordTorrent({ infoHash: B, name: "Big Buck Bunny" });

    const metadata = library.getTorrent(A)?.metadata;
    expect(Buffer.isBuffer(metadata)).toBe(true);
    expect(metadata).toEqual(METADATA);
    expect(library.getTorrent(B)).toMatchObject({
      metadata: null,
      hasMetadata: false,
    });
  });
});

describe("listRecent", () => {
  it(`shows the most recently opened first, ${RECENT_LIMIT} at most`, () => {
    const library = open();
    for (let n = 0; n < RECENT_LIMIT + 5; n++) {
      clock += 1000;
      library.recordTorrent({ infoHash: hash(n), name: `Torrent ${n}` });
    }

    const recent = library.listRecent();

    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]?.infoHash).toBe(hash(RECENT_LIMIT + 4));
    expect(recent.at(-1)?.infoHash).toBe(hash(5));
    expect(library.listRecent(3).map((entry) => entry.name)).toEqual([
      `Torrent ${RECENT_LIMIT + 4}`,
      `Torrent ${RECENT_LIMIT + 3}`,
      `Torrent ${RECENT_LIMIT + 2}`,
    ]);
  });

  it("orders torrents opened at the same moment by info hash", () => {
    const library = open();
    for (const infoHash of [B, C, A]) {
      library.recordTorrent({ infoHash, name: "Same time" });
    }

    expect(library.listRecent().map((entry) => entry.infoHash)).toEqual([
      A,
      B,
      C,
    ]);
  });

  it("brings a touched torrent to the top", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    clock += 1000;
    library.recordTorrent({ infoHash: B, name: "Big Buck Bunny" });
    clock += 1000;

    library.touchTorrent(A);

    expect(library.listRecent()[0]?.infoHash).toBe(A);
  });

  it("leaves out the metadata", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel", metadata: METADATA });

    const [entry] = library.listRecent();

    expect(entry).not.toHaveProperty("metadata");
    expect(entry?.hasMetadata).toBe(true);
  });

  it.each([0, -1, 1.5])("rejects a limit of %s", (limit) => {
    const library = open();

    expectLibraryError(
      () => library.listRecent(limit),
      "invalid_input",
      "limit",
    );
    expectLibraryError(
      () => library.listContinueWatching(limit),
      "invalid_input",
      "limit",
    );
  });
});

describe("saveProgress", () => {
  let library: LibraryStore;

  beforeEach(() => {
    library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
  });

  it("saves a position and reads it back", () => {
    library.saveProgress(progress({ fileIndex: 2, fileName: "b.mkv" }));
    clock += 1000;
    const saved = library.saveProgress(
      progress({ audioTrack: 1, subtitle: "file:5" }),
    );

    expect(saved).toStrictEqual({
      infoHash: A,
      fileIndex: 0,
      fileName: "Sintel.mp4",
      position: 600,
      duration: 888,
      audioTrack: 1,
      subtitle: "file:5",
      watched: false,
      updatedAt: clock,
    });
    expect(library.getFileProgress(A, 0)).toStrictEqual(saved);
    expect(library.getFileProgress(A, 1)).toBeNull();
    expect(library.getProgress(A).map((entry) => entry.fileIndex)).toEqual([
      0, 2,
    ]);
  });

  it("needs the torrent in the library first", () => {
    expectLibraryError(
      () => library.saveProgress(progress({ infoHash: B })),
      "not_found",
    );
    expect(library.getProgress(B)).toEqual([]);
  });

  it.each([
    ["position", Number.NaN],
    ["position", -1],
    ["position", Number.POSITIVE_INFINITY],
    ["duration", Number.NaN],
    ["duration", -5],
    ["duration", Number.POSITIVE_INFINITY],
    ["fileIndex", -1],
    ["fileIndex", 1.5],
    ["audioTrack", -1],
    ["audioTrack", 0.5],
    ["subtitle", ""],
    ["fileName", ""],
    ["infoHash", "A".repeat(40)],
  ])("rejects %s = %s and saves nothing", (field, value) => {
    expectLibraryError(
      () => library.saveProgress(progress({ [field]: value })),
      "invalid_input",
      field,
    );
    expect(library.getProgress(A)).toEqual([]);
  });

  it("keeps the audio track and subtitle when omitted, clears them with null", () => {
    library.saveProgress(progress({ audioTrack: 2, subtitle: "embedded:1" }));

    library.saveProgress(progress({ position: 700 }));
    expect(library.getFileProgress(A, 0)).toMatchObject({
      position: 700,
      audioTrack: 2,
      subtitle: "embedded:1",
    });

    library.saveProgress(progress({ audioTrack: null, subtitle: null }));
    expect(library.getFileProgress(A, 0)).toMatchObject({
      audioTrack: null,
      subtitle: null,
    });
  });

  it("keeps a known duration when the new one is unknown", () => {
    library.saveProgress(progress({ duration: 888 }));
    library.saveProgress(progress({ duration: null }));

    expect(library.getFileProgress(A, 0)?.duration).toBe(888);
  });

  it("keeps the latest file name", () => {
    library.saveProgress(progress({ fileName: "old.mp4" }));
    library.saveProgress(progress({ fileName: "new.mp4" }));

    expect(library.getFileProgress(A, 0)?.fileName).toBe("new.mp4");
  });

  it("marks a file watched near the end, by the rule", () => {
    expect(library.saveProgress(progress({ position: 800 })).watched).toBe(
      true,
    );
  });

  it("uses the saved duration for the rule when the new one is unknown", () => {
    library.saveProgress(progress({ position: 100, duration: 888 }));

    expect(
      library.saveProgress(progress({ position: 850, duration: null })).watched,
    ).toBe(true);
  });

  it("never marks a file of unknown duration watched by the rule", () => {
    expect(
      library.saveProgress(progress({ position: 99_999, duration: null }))
        .watched,
    ).toBe(false);
  });

  it("lets an explicit watched win, both ways", () => {
    expect(
      library.saveProgress(progress({ position: 10, watched: true })).watched,
    ).toBe(true);
    expect(
      library.saveProgress(progress({ position: 880, watched: false })).watched,
    ).toBe(false);
  });

  it("un-watches a finished file only once it's past 30 s again", () => {
    library.saveProgress(progress({ position: 880 }));

    // Start over, then close the player quickly: still watched.
    expect(library.saveProgress(progress({ position: 12 })).watched).toBe(true);
    // Really watching it again: back in Continue watching.
    expect(library.saveProgress(progress({ position: 45 })).watched).toBe(
      false,
    );
    expect(library.listContinueWatching()).toHaveLength(1);
  });

  it("rejects a non-boolean watched", () => {
    expectLibraryError(
      () =>
        library.saveProgress({
          ...progress(),
          watched: "yes" as unknown as boolean,
        }),
      "invalid_input",
      "watched",
    );
  });
});

describe("listContinueWatching", () => {
  it("shows unwatched files past 30 s, newest first, with the torrent's name", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    library.recordTorrent({ infoHash: B, name: "Big Buck Bunny" });
    library.saveProgress(progress({ fileIndex: 0, position: 30 }));
    clock += 1000;
    library.saveProgress(progress({ fileIndex: 1, position: 30.5 }));
    clock += 1000;
    library.saveProgress(progress({ infoHash: B, position: 300 }));
    clock += 1000;
    library.saveProgress(progress({ fileIndex: 2, watched: true }));

    const items = library.listContinueWatching();

    expect(items.map((item) => [item.infoHash, item.fileIndex])).toEqual([
      [B, 0],
      [A, 1],
    ]);
    expect(items[0]).toStrictEqual({
      infoHash: B,
      fileIndex: 0,
      fileName: "Sintel.mp4",
      position: 300,
      duration: 888,
      audioTrack: null,
      subtitle: null,
      watched: false,
      updatedAt: clock - 1000,
      torrentName: "Big Buck Bunny",
    });
  });

  it(`shows ${CONTINUE_WATCHING_LIMIT} at most, and breaks ties by torrent and file`, () => {
    const library = open();
    library.recordTorrent({ infoHash: B, name: "B" });
    library.recordTorrent({ infoHash: A, name: "A" });
    for (
      let fileIndex = 0;
      fileIndex < CONTINUE_WATCHING_LIMIT + 5;
      fileIndex++
    ) {
      library.saveProgress(progress({ infoHash: B, fileIndex }));
      library.saveProgress(progress({ infoHash: A, fileIndex }));
    }

    const items = library.listContinueWatching();

    expect(items).toHaveLength(CONTINUE_WATCHING_LIMIT);
    expect(
      items.slice(0, 3).map((item) => [item.torrentName, item.fileIndex]),
    ).toEqual([
      ["A", 0],
      ["A", 1],
      ["A", 2],
    ]);
    expect(library.listContinueWatching(2)).toHaveLength(2);
  });
});

describe("forgetting", () => {
  let library: LibraryStore;

  beforeEach(() => {
    library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    library.recordTorrent({ infoHash: B, name: "Big Buck Bunny" });
    library.saveProgress(progress({ fileIndex: 0 }));
    library.saveProgress(progress({ fileIndex: 1 }));
    library.saveProgress(progress({ infoHash: B }));
  });

  it("deleteProgress forgets one file's position", () => {
    expect(library.deleteProgress(A, 0)).toBe(true);
    expect(library.deleteProgress(A, 0)).toBe(false);

    expect(library.getProgress(A).map((entry) => entry.fileIndex)).toEqual([1]);
    expect(library.getProgress(B)).toHaveLength(1);
  });

  it("forgetTorrent removes the torrent and its positions (cascade)", () => {
    expect(library.forgetTorrent(A)).toBe(true);
    expect(library.forgetTorrent(A)).toBe(false);

    expect(library.getTorrent(A)).toBeNull();
    expect(
      peek(file, `SELECT count(*) FROM progress WHERE info_hash = '${A}'`),
    ).toBe(0);
    // Adding it again starts from a clean slate.
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    expect(library.getProgress(A)).toEqual([]);
    expect(library.getProgress(B)).toHaveLength(1);
  });

  it("validates its input", () => {
    expectLibraryError(() => library.forgetTorrent("../.."), "invalid_input");
    expectLibraryError(() => library.deleteProgress(A, -1), "invalid_input");
  });
});

describe("thumbnails", () => {
  let library: LibraryStore;
  const makeThumbnail = (infoHash: string, fileIndex: number) => {
    const path = library.thumbnailPath(infoHash, fileIndex);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "jpeg");
    return path;
  };

  beforeEach(() => {
    library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    library.recordTorrent({ infoHash: B, name: "Big Buck Bunny" });
  });

  it("live next to library.db, one folder per torrent", () => {
    expect(library.thumbnailPath(A, 3)).toBe(
      join(dir, "thumbnails", A, "3.jpg"),
    );
    expectLibraryError(() => library.thumbnailPath("..", 3), "invalid_input");
    expectLibraryError(() => library.thumbnailPath(A, 0.5), "invalid_input");
  });

  it("go with the file's position", () => {
    library.saveProgress(progress({ fileIndex: 0 }));
    const gone = makeThumbnail(A, 0);
    const kept = makeThumbnail(A, 1);

    library.deleteProgress(A, 0);

    expect(existsSync(gone)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("go with the torrent", () => {
    const gone = [makeThumbnail(A, 0), makeThumbnail(A, 1)];
    const kept = makeThumbnail(B, 0);

    library.forgetTorrent(A);

    expect(gone.some((path) => existsSync(path))).toBe(false);
    expect(existsSync(join(dir, "thumbnails", A))).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it.skipIf(!permissionsWork)(
    "that can't be deleted are logged, not thrown",
    () => {
      library.saveProgress(progress());
      const path = makeThumbnail(A, 0);
      chmodSync(dirname(path), 0o500);

      try {
        expect(library.deleteProgress(A, 0)).toBe(true);
      } finally {
        chmodSync(dirname(path), 0o700);
      }
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ path }),
        "Could not delete a thumbnail",
      );
    },
  );
});

describe("close", () => {
  it("makes every later call throw clearly; closing twice is fine", () => {
    const library = open();
    library.recordTorrent({ infoHash: A, name: "Sintel" });
    library.close();
    library.close();

    const calls: (() => unknown)[] = [
      () => library.recordTorrent({ infoHash: A, name: "Sintel" }),
      () => library.touchTorrent(A),
      () => library.getTorrent(A),
      () => library.listRecent(),
      () => library.getProgress(A),
      () => library.getFileProgress(A, 0),
      () => library.saveProgress(progress()),
      () => library.listContinueWatching(),
      () => library.deleteProgress(A, 0),
      () => library.forgetTorrent(A),
      () => library.thumbnailPath(A, 0),
    ];
    for (const call of calls) expectLibraryError(call, "closed");
  });
});

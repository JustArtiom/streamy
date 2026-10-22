import { execFileSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { TorrentDetail } from "../../shared/engine-api";
import { AppError, ErrorCode } from "../http/errors";
import { fileKind } from "../lib/file-kind";
import { mintFileToken } from "../torrents/file-tokens";
import type { TorrentFileHandle, TorrentService } from "../torrents/service";

/*
 * Test helpers for the media code, with real ffmpeg on generated files.
 *
 * ffmpeg only reads torrent data over http (-protocol_whitelist), the way
 * the engine serves it: tests run the real /internal/files/<token> route
 * on top of fakeTorrents (a stand-in for torrentService whose files are
 * plain files on disk), or serveFile() for code that just needs a URL.
 *
 * Nothing here may import torrents/service at runtime: test files mock that
 * module with fakeTorrents.
 */

/** Runs ffmpeg to make a test file (quiet, overwrites). */
export function makeMedia(ffmpeg: string, args: string[]): void {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}

/** Bytes [start, end] of `file`, `delayMs` between 64 KiB chunks (a slow torrent). */
export function slowReadStream(
  file: string,
  range: { start: number; end: number },
  delayMs: number,
): Readable {
  const source = createReadStream(file, {
    ...range,
    highWaterMark: 64 * 1024,
  });
  return Readable.from(
    (async function* () {
      try {
        for await (const chunk of source) {
          await sleep(delayMs);
          yield chunk as Buffer;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
}

/** Bytes [start, end] of `file`, failing (like a dropped torrent read) after `cutAfter` bytes. */
function cutReadStream(
  file: string,
  range: { start: number; end: number },
  cutAfter: number,
  onCut: () => void,
): Readable {
  const source = createReadStream(file, range);
  return Readable.from(
    (async function* () {
      let sent = 0;
      try {
        for await (const chunk of source) {
          const buffer = chunk as Buffer;
          if (sent + buffer.length > cutAfter) {
            yield buffer.subarray(0, Math.max(0, cutAfter - sent));
            onCut();
            throw new Error("The file stream ended early");
          }
          sent += buffer.length;
          yield buffer;
        }
      } finally {
        source.destroy();
      }
    })(),
  );
}

export type ServedFile = {
  url: string;
  /** "GET bytes=0-" for every request so far. */
  requests: string[];
  close(): Promise<void>;
};

/** Serves one file with Range support at http://127.0.0.1:<port>/<name> (anything else: 404). */
export async function serveFile(
  file: string,
  name = "file",
): Promise<ServedFile> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method ?? "GET"} ${req.headers.range ?? "-"}`);
    if (req.url !== `/${name}`) {
      res.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0;
    let end = size - 1;
    if (match) {
      if (match[1]) start = Number(match[1]);
      else start = size - Number(match[2]);
      if (match[1] && match[2]) end = Math.min(Number(match[2]), size - 1);
    }
    res.writeHead(match ? 206 : 200, {
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      ...(match && { "Content-Range": `bytes ${start}-${end}/${size}` }),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file, { start, end }).pipe(res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${name}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

// ─── A fake torrent service ──────────────────────────────────────────────────

export type FakeFile = {
  /** "Movie.mkv": its extension decides the kind. */
  name: string;
  /** The bytes, on disk. */
  path: string;
  /** TorrentFile.progress (0..1); 1 = downloaded. */
  progress?: number;
  /** ms between 64 KiB chunks of every read (a torrent still downloading). */
  slowMs?: number;
  /**
   * The first read fails after this many bytes (the connection drops).
   * Then the torrent is either still there ("ok": ffmpeg reconnects) or
   * gone ("gone": every later read is a 404).
   */
  cut?: { after: number; then: "ok" | "gone" };
};

type FakeTorrent = { files: FakeFile[]; cut: boolean };

export type FakeTorrents = {
  service: Pick<
    TorrentService,
    "get" | "getFile" | "focusFile" | "touch" | "onRemoved"
  >;
  add(infoHash: string, files: FakeFile[]): void;
  /** Like a DELETE: listeners hear about it, reads fail from now on. */
  remove(infoHash: string): void;
  /** Token URLs handed out, and how many were revoked. */
  tokens: { minted: number; revoked: number };
};

function createFakeTorrents(): FakeTorrents {
  const torrents = new Map<string, FakeTorrent>();
  const removedListeners = new Set<(infoHash: string) => void>();
  const tokens = { minted: 0, revoked: 0 };

  function find(infoHash: string): FakeTorrent {
    const torrent = torrents.get(infoHash);
    if (!torrent) throw new AppError(ErrorCode.NotFound, "Torrent not found");
    return torrent;
  }

  function handle(
    infoHash: string,
    index: number,
    torrent: FakeTorrent,
  ): TorrentFileHandle {
    const file = torrent.files[index];
    if (!file) throw new AppError(ErrorCode.NotFound, "File not found");
    if (file.cut?.then === "gone" && torrent.cut) {
      throw new AppError(ErrorCode.NotFound, "This torrent was removed");
    }
    const size = statSync(file.path).size;
    return {
      infoHash,
      index,
      name: file.name,
      path: `Fake/${file.name}`,
      size,
      kind: fileKind(file.name),
      mintInternalUrl() {
        tokens.minted += 1;
        const real = mintFileToken({ infoHash, fileIndex: index });
        return {
          ...real,
          revoke() {
            tokens.revoked += 1;
            real.revoke();
          },
        };
      },
      readAll: () => readFile(file.path),
      createReadStream(range = { start: 0, end: size - 1 }) {
        if (file.cut && !torrent.cut) {
          return cutReadStream(file.path, range, file.cut.after, () => {
            torrent.cut = true;
          });
        }
        if (file.slowMs) return slowReadStream(file.path, range, file.slowMs);
        return createReadStream(file.path, range);
      },
    };
  }

  return {
    tokens,
    add(infoHash, files) {
      torrents.set(infoHash, { files, cut: false });
    },
    remove(infoHash) {
      torrents.delete(infoHash);
      for (const listener of removedListeners) listener(infoHash);
    },
    service: {
      get(infoHash): TorrentDetail {
        const { files } = find(infoHash);
        const now = new Date().toISOString();
        return {
          infoHash,
          name: "Fake",
          status: "ready",
          error: null,
          size: 1,
          progress: 1,
          downloadSpeed: 0,
          uploadSpeed: 0,
          peers: 1,
          addedAt: now,
          lastActivityAt: now,
          files: files.map((file, index) => ({
            index,
            name: file.name,
            path: `Fake/${file.name}`,
            size: statSync(file.path).size,
            kind: fileKind(file.name),
            progress: file.progress ?? 1,
          })),
        };
      },
      getFile(infoHash, index) {
        return handle(infoHash, index, find(infoHash));
      },
      focusFile: () => undefined,
      touch: () => undefined,
      onRemoved(listener) {
        const wrapped = (infoHash: string) => {
          listener(infoHash, { dataDeleted: true, forget: false });
        };
        removedListeners.add(wrapped);
        return () => {
          removedListeners.delete(wrapped);
        };
      },
    },
  };
}

/** One per test file (each file gets its own module instance). */
export const fakeTorrents: FakeTorrents = createFakeTorrents();

// ─── Picture subtitles ───────────────────────────────────────────────────────

/**
 * A PGS (.sup) subtitle track ffmpeg can read but not write: on a `canvas`
 * (e.g. 1920×1080), a white box at `box`, shown for 3 s at each of `times`.
 */
export function pgsSubtitles(
  canvas: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
  times: number[],
): Buffer {
  const segment = (pts: number, type: number, data: Buffer) => {
    const header = Buffer.alloc(13);
    header.write("PG", 0, "latin1");
    header.writeUInt32BE(pts, 2);
    header.writeUInt32BE(0, 6);
    header.writeUInt8(type, 10);
    header.writeUInt16BE(data.length, 11);
    return Buffer.concat([header, data]);
  };
  const u16 = (...values: number[]) => {
    const buffer = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => buffer.writeUInt16BE(value, i * 2));
    return buffer;
  };
  const u8 = (...values: number[]) => Buffer.from(values);
  const window = Buffer.concat([
    u8(1, 0),
    u16(box.x, box.y, box.width, box.height),
  ]);
  const composition = (number: number, shown: boolean) =>
    Buffer.concat([
      u16(canvas.width, canvas.height),
      u8(0x10),
      u16(number),
      u8(shown ? 0x80 : 0, 0, 0, shown ? 1 : 0),
      ...(shown ? [u16(0), u8(0, 0), u16(box.x, box.y)] : []),
    ]);
  // One palette entry: white (Y 235), opaque. Every line: a run of colour 1.
  const palette = u8(0, 0, 1, 235, 128, 128, 255);
  const line = u8(0, 0xc0 | (box.width >> 8), box.width & 0xff, 1, 0, 0);
  const rle = Buffer.concat(Array.from({ length: box.height }, () => line));
  const objectLength = Buffer.alloc(3);
  objectLength.writeUIntBE(rle.length + 4, 0, 3);
  const object = Buffer.concat([
    u16(0),
    u8(0, 0xc0),
    objectLength,
    u16(box.width, box.height),
    rle,
  ]);

  const parts: Buffer[] = [];
  let number = 0;
  for (const time of times) {
    const show = Math.round(time * 90_000);
    const hide = Math.round((time + 3) * 90_000);
    parts.push(
      segment(show, 0x16, composition(number++, true)),
      segment(show, 0x17, window),
      segment(show, 0x14, palette),
      segment(show, 0x15, object),
      segment(show, 0x80, Buffer.alloc(0)),
      segment(hide, 0x16, composition(number++, false)),
      segment(hide, 0x17, window),
      segment(hide, 0x80, Buffer.alloc(0)),
    );
  }
  return Buffer.concat(parts);
}

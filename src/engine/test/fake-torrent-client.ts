import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { type ParsedTorrent, toTorrentFile } from "parse-torrent";
import type { AddOptions, TorrentInfo } from "webtorrent";

/*
 * Test helper: a stand-in for the WebTorrent client with no network and no
 * disk. Tests drive it by hand (metadata arriving, pieces, errors, peers…)
 * and check what the service asked of it (selections, open reads, destroy).
 *
 *   vi.mock("../torrents/client", async () => {
 *     const { fakeClient } = await import("../test/fake-torrent-client");
 *     return { getTorrentClient: () => fakeClient, … };
 *   });
 *
 * Like WebTorrent 3.0.21: "metadata" comes first, then (a moment later,
 * once the data on disk is checked) "ready"; a file read with `end: 0`
 * reads to the end of the file; `torrentFile` is a real .torrent.
 */

export class FakeFile {
  readonly path: string;
  readonly data: Buffer;
  readonly length: number;
  readonly offset = 0;
  progress = 0;
  downloaded = 0;
  done = false;
  /** The background selection (select/deselect). */
  selected = false;
  selectedPriority: number | undefined;
  /** Reads that were started, and the ones still open. */
  readsStarted = 0;
  openReads = 0;
  /** The byte range of every read asked for, as WebTorrent reads it. */
  readRanges: { start: number; end: number }[] = [];
  /** true = reads wait forever for pieces (until released). */
  stalled = false;

  constructor(path: string, data: Buffer) {
    this.path = path;
    this.data = data;
    this.length = data.length;
  }

  get name(): string {
    return basename(this.path);
  }

  select(priority?: number) {
    this.selected = true;
    this.selectedPriority = priority;
  }

  deselect() {
    this.selected = false;
  }

  [Symbol.asyncIterator](range: { start?: number; end?: number } = {}) {
    const start = range.start ?? 0;
    // WebTorrent: a missing (or 0) end means "to the end of the file".
    const end =
      range.end && range.end < this.length ? range.end : this.length - 1;
    const bytes = this.data.subarray(start, end + 1);
    let position = 0;
    let closed = false;
    let wake: (() => void) | null = null;
    this.readsStarted += 1;
    this.openReads += 1;
    this.readRanges.push({ start, end });

    const close = () => {
      if (closed) return;
      closed = true;
      this.openReads -= 1;
      wake?.();
    };

    return {
      next: async (): Promise<IteratorResult<Uint8Array>> => {
        if (this.stalled && !closed) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        if (closed || position >= bytes.length) {
          close();
          return { done: true, value: undefined };
        }
        // Small chunks, like pieces, so streams see several of them.
        const chunk = bytes.subarray(position, position + 16);
        position += chunk.length;
        return { done: false, value: chunk };
      },
      return: (): Promise<IteratorResult<Uint8Array>> => {
        close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }
}

/** A connection to a peer, as much of it as the service uses. */
export class FakeWire {
  readonly type: string;
  /** The last setTimeout (WebTorrent starts every peer wire at 30 s). */
  timeoutMs: number;

  constructor(type: string, timeoutMs = 30_000) {
    this.type = type;
    this.timeoutMs = timeoutMs;
  }

  setTimeout(ms: number) {
    this.timeoutMs = ms;
  }
}

export class FakeTorrent extends EventEmitter {
  readonly infoHash: string;
  readonly torrentId: string | Uint8Array | ParsedTorrent;
  readonly options: AddOptions;
  name = "";
  length = 0;
  pieceLength = 16384;
  ready = false;
  destroyed = false;
  done = false;
  info: TorrentInfo | undefined;
  torrentFile: Uint8Array | undefined;
  /** Pieces on disk: one bit per piece (set once the metadata is in). */
  bitfield: { buffer: Uint8Array; get(index: number): boolean } | undefined;
  files: FakeFile[] = [];
  progress = 0;
  downloaded = 0;
  downloadSpeed = 0;
  uploadSpeed = 0;
  numPeers = 0;
  destroyOptions: { destroyStore?: boolean } | null | undefined;
  wires: FakeWire[] = [];
  /** Every addPeer() call. */
  peersAdded: string[] = [];
  /** How many times the trackers were asked for peers again. */
  trackerUpdates = 0;
  discovery = {
    tracker: {
      update: () => {
        this.trackerUpdates += 1;
      },
    },
  };

  constructor(
    infoHash: string,
    torrentId: string | Uint8Array | ParsedTorrent,
    options: AddOptions,
  ) {
    super();
    this.infoHash = infoHash;
    this.torrentId = torrentId;
    this.options = options;
  }

  /**
   * The metadata arrives ("metadata"); a moment later the data on disk is
   * checked and it's "ready" (await this to see it ready). `checking:
   * true` keeps it checking until finishChecking(). `info` = the raw info
   * the torrent declares (default: the one it was added with, or one made
   * from `files`).
   */
  async receiveMetadata(
    name: string,
    files: { path: string; data?: Buffer }[],
    options: { info?: TorrentInfo; checking?: boolean } = {},
  ): Promise<void> {
    this.name = name;
    this.files = files.map(
      (file) => new FakeFile(file.path, file.data ?? Buffer.alloc(0)),
    );
    this.length = this.files.reduce((sum, file) => sum + file.length, 0);
    const made = torrentFileFor(
      name,
      this.files.map((file) => ({ path: file.path, length: file.length })),
    );
    // Like WebTorrent: from the .torrent it was added with, if any.
    const given = this.torrentId;
    const parsed =
      typeof given === "object" && !(given instanceof Uint8Array)
        ? given
        : null;
    this.torrentFile =
      given instanceof Uint8Array
        ? given
        : parsed?.info
          ? toTorrentFile({ info: parsed.info })
          : made.bytes;
    this.info = options.info ?? parsed?.info ?? made.info;
    const pieces = Math.max(1, Math.ceil(this.length / this.pieceLength));
    const buffer = new Uint8Array(Math.ceil(pieces / 8));
    this.bitfield = {
      buffer,
      get: (index) => ((buffer[index >> 3] ?? 0) & (0x80 >> (index % 8))) !== 0,
    };
    this.emit("metadata");
    if (this.destroyed || options.checking) return;
    // WebTorrent checks what's on disk in between (asynchronously).
    await Promise.resolve();
    this.finishChecking();
  }

  /** The data on disk is checked: "ready". */
  finishChecking() {
    if (this.destroyed || this.ready) return;
    this.ready = true;
    this.emit("ready");
  }

  /** A piece is downloaded and written: its bit is set, "verified". */
  verifyPiece(index: number) {
    const buffer = this.bitfield?.buffer;
    if (!buffer) throw new Error("No metadata yet");
    buffer[index >> 3] = (buffer[index >> 3] ?? 0) | (0x80 >> (index % 8));
    this.emit("verified", index);
  }

  /** Every piece is in. */
  complete() {
    this.done = true;
    this.emit("done");
  }

  /** A peer connects ("wire"). Outgoing ones come with their address. */
  connectWire(type = "tcpOutgoing", address?: string): FakeWire {
    const wire = new FakeWire(type);
    this.wires.push(wire);
    this.emit("wire", wire, address);
    return wire;
  }

  /** What WebTorrent does on a fatal torrent error. */
  fail(error: string | Error) {
    this.emit("error", typeof error === "string" ? new Error(error) : error);
    this.destroy();
  }

  addPeer(address: string): boolean {
    if (this.destroyed) throw new Error("torrent is destroyed");
    this.peersAdded.push(address);
    return true;
  }

  destroy(
    options?: { destroyStore?: boolean } | null,
    callback?: (err?: Error | null) => void,
  ) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyOptions = options;
    this.emit("close");
    callback?.(null);
  }
}

export class FakeClient {
  torrents: FakeTorrent[] = [];

  add(
    torrentId: string | Uint8Array | ParsedTorrent,
    options: AddOptions = {},
  ): FakeTorrent {
    // The service puts each torrent in a folder named after its info hash.
    const torrent = new FakeTorrent(
      basename(options.path ?? ""),
      torrentId,
      options,
    );
    this.torrents.push(torrent);
    return torrent;
  }

  get(infoHash: string): FakeTorrent {
    const torrent = this.torrents.findLast((t) => t.infoHash === infoHash);
    if (!torrent) throw new Error(`No fake torrent ${infoHash}`);
    return torrent;
  }
}

export const fakeClient = new FakeClient();

// ─── .torrent files ──────────────────────────────────────────────────────────

type Bencodable = number | string | Buffer | Bencodable[] | BencodeDict;
type BencodeDict = { [key: string]: Bencodable };

function bencode(value: Bencodable): Buffer {
  if (typeof value === "number") return Buffer.from(`i${value}e`);
  if (typeof value === "string") return bencode(Buffer.from(value));
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      Buffer.from("l"),
      ...value.map(bencode),
      Buffer.from("e"),
    ]);
  }
  const keys = Object.keys(value).sort();
  return Buffer.concat([
    Buffer.from("d"),
    ...keys.flatMap((key) => [bencode(key), bencode(value[key] as Bencodable)]),
    Buffer.from("e"),
  ]);
}

/** A valid .torrent file, its info hash and its raw `info`. */
export function makeTorrentFile(options: {
  name: string;
  files: { path: string[]; length: number }[];
  private?: boolean;
  /** Its announce list (default: one made-up tracker). */
  announce?: string[];
  /** Its web seeds (url-list). */
  urlList?: string[];
}): { bytes: Buffer; infoHash: string; info: TorrentInfo } {
  const length = options.files.reduce((sum, file) => sum + file.length, 0);
  const pieces = Math.max(1, Math.ceil(length / 16384));
  const info: BencodeDict = {
    name: options.name,
    "piece length": 16384,
    pieces: Buffer.alloc(20 * pieces),
    files: options.files.map((file) => ({
      length: file.length,
      path: file.path,
    })),
    ...(options.private && { private: 1 }),
  };
  const infoHash = createHash("sha1").update(bencode(info)).digest("hex");
  const [first, ...rest] = options.announce ?? ["udp://tracker.example:1337"];
  const torrent: BencodeDict = {
    info,
    ...(first !== undefined && { announce: first }),
    ...(rest.length > 0 && {
      "announce-list": [[first ?? ""], ...rest.map((url) => [url])],
    }),
    ...(options.urlList && { "url-list": options.urlList }),
  };
  return {
    bytes: bencode(torrent),
    infoHash,
    info: {
      name: Buffer.from(options.name),
      files: options.files.map((file) => ({
        path: file.path.map((part) => Buffer.from(part)),
      })),
    },
  };
}

/**
 * The .torrent a fake torrent gets for these files ("Name/a.mkv" paths,
 * like receiveMetadata's), so a test can add it by that info hash.
 */
export function torrentFileFor(
  name: string,
  files: { path: string; length: number }[],
): { bytes: Buffer; infoHash: string; info: TorrentInfo } {
  return makeTorrentFile({
    name,
    files: files.map((file) => {
      const parts = file.path.split("/");
      return {
        path: parts.length > 1 && parts[0] === name ? parts.slice(1) : parts,
        length: file.length,
      };
    }),
  });
}

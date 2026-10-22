// WebTorrent v3 and parse-torrent ship no TypeScript types. These cover only
// what the engine uses (checked against webtorrent 3.0.21 / parse-torrent 11).

declare module "webtorrent" {
  import { EventEmitter } from "node:events";

  export type ClientOptions = {
    /** Bytes per second, -1 = unlimited. */
    downloadLimit?: number;
    uploadLimit?: number;
    /** Peer connections per torrent. */
    maxConns?: number;
    /** uTP (needs the utp-native add-on). On by default when it loads. */
    utp?: boolean;
    /** false turns these off (tests: a local seeder only, no internet). */
    dht?: boolean;
    tracker?: boolean;
    lsd?: boolean;
    utPex?: boolean;
    natUpnp?: boolean;
    natPmp?: boolean;
    webSeeds?: boolean;
  };

  export type AddOptions = {
    /** Folder the torrent's files are written to. */
    path?: string;
    /** Start with nothing selected: only what we read gets downloaded. */
    deselect?: boolean;
    /** Delete the files when the torrent is destroyed. */
    destroyStoreOnDestroy?: boolean;
    /** Extra trackers, added to the ones in the magnet / .torrent. */
    announce?: string[];
    /**
     * Fast resume: pieces already on disk (Torrent.bitfield.buffer from an
     * earlier run). Trusted, with one piece per file hashed as a spot check.
     * Ignored (full check) unless it's exactly ceil(pieces / 8) bytes.
     */
    bitfield?: Uint8Array;
  };

  /** Raw bencoded `info` dictionary (strings are bytes). */
  export type TorrentInfo = {
    name?: Uint8Array;
    "name.utf-8"?: Uint8Array;
    files?: { path?: Uint8Array[]; "path.utf-8"?: Uint8Array[] }[];
  };

  /**
   * Reads bytes [start, end] (inclusive) of a file. While it exists, those
   * pieces are selected with priority; return() drops that selection.
   */
  export type FileIterator = AsyncIterator<Uint8Array> & {
    return(): Promise<IteratorResult<Uint8Array>>;
  };

  export interface TorrentFile {
    readonly name: string;
    /** Path inside the torrent, e.g. "Sintel/Sintel.mp4". */
    readonly path: string;
    readonly length: number;
    readonly offset: number;
    /** 0..1 */
    readonly progress: number;
    readonly downloaded: number;
    readonly done: boolean;
    /** Download the whole file; priority 0 (default) = background. */
    select(priority?: number): void;
    /** Drops select() selections over this file (not reads in progress). */
    deselect(): void;
    /** Careful: `end: 0` is read as "until the end of the file". */
    [Symbol.asyncIterator](range?: {
      start?: number;
      end?: number;
    }): FileIterator;
  }

  /** A connection to one peer (bittorrent-protocol's Wire). */
  export interface Wire {
    /**
     * "tcpOutgoing", "utpOutgoing" (we connected to it), "tcpIncoming",
     * "utpIncoming", "webrtc", "webSeed".
     */
    readonly type: string;
    /**
     * How long to wait for the peer to answer a request before closing the
     * connection. 0 = wait forever. WebTorrent sets 30 s (unref'd).
     */
    setTimeout(ms: number, unref?: boolean): void;
  }

  /** How a torrent finds peers (torrent-discovery). */
  export interface Discovery {
    /** null when trackers are off. */
    readonly tracker: { update(): void } | null;
  }

  export interface Torrent extends EventEmitter {
    readonly infoHash: string;
    readonly name: string;
    /** Total bytes. */
    readonly length: number;
    readonly pieceLength: number;
    /** Metadata is here and existing data was checked. */
    readonly ready: boolean;
    readonly destroyed: boolean;
    readonly done: boolean;
    /** Raw info dictionary, once the metadata is known. */
    readonly info?: TorrentInfo;
    /** The .torrent file (bencoded), once the metadata is known. */
    readonly torrentFile?: Uint8Array;
    /** Plain objects until the metadata arrives, then real files. */
    readonly files: TorrentFile[];
    /**
     * Verified pieces (set once the metadata is known). `buffer` is one bit
     * per piece, first piece = highest bit of byte 0.
     */
    readonly bitfield?: { get(index: number): boolean; buffer: Uint8Array };
    readonly progress: number;
    readonly downloaded: number;
    readonly downloadSpeed: number;
    readonly uploadSpeed: number;
    readonly numPeers: number;
    /** Connections to peers right now. */
    readonly wires: Wire[];
    /** Set once it starts looking for peers; null after it's destroyed. */
    readonly discovery: Discovery | null | undefined;
    /**
     * Connects to a peer directly ("127.0.0.1:6881"). false for one it
     * already has. Throws if destroyed, or before the info hash is known.
     */
    addPeer(peer: string): boolean;
    destroy(
      options?: { destroyStore?: boolean } | null,
      callback?: (err?: Error | null) => void,
    ): void;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(options?: ClientOptions);
    readonly destroyed: boolean;
    readonly torrents: Torrent[];
    /** Read by every torrent when it looks for more peers. */
    maxConns: number;
    /** The port peers can connect to (once listening). */
    readonly torrentPort: number;
    /**
     * A magnet, .torrent bytes, or a torrent parse-torrent already parsed
     * (its extra `announce`, `urlList` and `peerAddresses` are used too).
     */
    add(
      torrentId: string | Uint8Array | import("parse-torrent").ParsedTorrent,
      options?: AddOptions,
    ): Torrent;
    /** Starts sharing local files (tests only). */
    seed(
      input: string | string[],
      options: { announce?: string[]; name?: string },
      onSeed?: (torrent: Torrent) => void,
    ): Torrent;
    /** Bytes per second, -1 = unlimited. false = invalid rate. */
    throttleDownload(rate: number): boolean | undefined;
    throttleUpload(rate: number): boolean | undefined;
    destroy(callback?: (err?: Error | null) => void): void;
  }
}

declare module "parse-torrent" {
  export type ParsedTorrent = {
    /** 40 lowercase hex chars. */
    infoHash: string;
    name?: string;
    /** Only for .torrent files (not magnets): the raw info dictionary. */
    info?: import("webtorrent").TorrentInfo;
    /** Only for .torrent files. Paths are already normalised (no ".."). */
    files?: { path: string; name: string; length: number }[];
    /** Private torrents must only use their own trackers. */
    private?: boolean;
    /** Trackers (a magnet's `tr`, a .torrent's announce list). */
    announce?: string[];
    /** Web seeds (a magnet's `ws`, a .torrent's url-list). */
    urlList?: string[];
    /** Peers named by a magnet's `x.pe` ("127.0.0.1:6881"). */
    peerAddresses?: string[];
  };

  /** Magnet URI, info hash, or .torrent bytes. Throws on bad input. */
  export default function parseTorrent(
    torrentId: string | Uint8Array,
  ): Promise<ParsedTorrent>;

  /** Bencodes `{ info, announce, … }` into .torrent bytes (tests). */
  export function toTorrentFile(parsed: {
    info: Record<string, unknown>;
    announce?: string[];
  }): Uint8Array;
}

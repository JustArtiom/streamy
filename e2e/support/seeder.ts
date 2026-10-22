import { once } from "node:events";
import WebTorrent, { type Torrent } from "webtorrent";

// A WebTorrent client in the test process that shares the test videos with
// Streamy over loopback, and nothing else: no DHT, trackers, LSD, peer
// exchange, port mapping, web seeds or uTP. The magnet names it directly
// (x.pe=127.0.0.1:<port>), so no internet is involved.

export type Seeder = {
  infoHash: string;
  /** The torrent's name (its folder). */
  name: string;
  /** magnet:?xt=…&dn=…&x.pe=127.0.0.1:<port>, no trackers. */
  magnet: string;
  /** The .torrent file. */
  torrentFile: Buffer;
  /** Stops sharing and closes every connection. Safe to call twice. */
  stop: () => Promise<void>;
};

const OFFLINE = {
  dht: false,
  tracker: false,
  lsd: false,
  utPex: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
  utp: false,
} as const;

/**
 * Starts sharing `folder` (it becomes the torrent, named after it), at most
 * `uploadLimit` bytes per second (null: as fast as it can).
 */
export async function startSeeder(
  folder: string,
  { uploadLimit = null }: { uploadLimit?: number | null } = {},
): Promise<Seeder> {
  const client = new WebTorrent({ ...OFFLINE, uploadLimit: uploadLimit ?? -1 });
  let stopped: Promise<void> | null = null;
  const stop = () => {
    stopped ??= new Promise<void>((resolve) => {
      client.destroy(() => {
        resolve();
      });
    });
    return stopped;
  };

  try {
    const listening = client.torrentPort
      ? Promise.resolve()
      : once(client, "listening");
    const torrent = await new Promise<Torrent>((resolve, reject) => {
      client.once("error", reject);
      client.seed(folder, { announce: [] }, resolve);
    });
    await listening;
    if (!torrent.torrentFile) throw new Error("The seeder has no .torrent");

    const magnet =
      `magnet:?xt=urn:btih:${torrent.infoHash}` +
      `&dn=${encodeURIComponent(torrent.name)}` +
      `&x.pe=127.0.0.1:${client.torrentPort}`;
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      magnet,
      torrentFile: Buffer.from(torrent.torrentFile),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

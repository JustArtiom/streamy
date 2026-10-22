// The app's URLs, in one place. The routes themselves are in router.tsx.

/** The torrent page: its files, with Play buttons. */
export function torrentPath(infoHash: string): string {
  return `/torrent/${infoHash}`;
}

/** The player. */
export function watchPath(infoHash: string, fileIndex: number): string {
  return `/watch/${infoHash}/${fileIndex}`;
}

/** Location state for the torrent page (see pages/torrent.tsx). */
export type TorrentPageState = {
  /**
   * It was just added: with exactly one video, the page goes straight to
   * the player.
   */
  justAdded?: boolean;
};

/** Location state for the player (see pages/watch.tsx). */
export type WatchPageState = {
  /**
   * Where to start, when the link already said ("Resume at 34:12"), so
   * the player doesn't ask again. Without it, the player asks when there's
   * a position to resume.
   */
  start?: "resume" | "beginning";
};

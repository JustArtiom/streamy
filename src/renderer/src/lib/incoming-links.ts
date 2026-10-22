import type { TorrentFileOpened } from "../../../shared/api";

// Magnet links and .torrent files opened with Streamy from outside: a link
// clicked in a browser, a file double-clicked in Finder, or the one that
// launched the app (see src/main/magnet-links.ts). They can arrive before
// the page that handles them is ready, so they wait here, in order, until
// it is (components/layout/incoming-links.tsx).

export type IncomingLink =
  | { kind: "magnet"; link: string }
  /** The main process already added the file to the engine. */
  | { kind: "torrent-file"; result: TorrentFileOpened };

type Handler = (link: IncomingLink) => void;

const pending: IncomingLink[] = [];
let handler: Handler | null = null;

function deliver(link: IncomingLink) {
  if (handler) handler(link);
  else pending.push(link);
}

// Subscribed as soon as the UI loads, so even the first link isn't missed.
window.streamy.onMagnetLink((link) => {
  deliver({ kind: "magnet", link });
});
window.streamy.onTorrentFileOpened((result) => {
  deliver({ kind: "torrent-file", result });
});

/**
 * Calls `onLink` for every link opened with Streamy, starting with the ones
 * that arrived before. Only one handler at a time; returns its removal.
 */
export function handleIncomingLinks(onLink: Handler): () => void {
  handler = onLink;
  for (const link of pending.splice(0)) onLink(link);
  return () => {
    if (handler === onLink) handler = null;
  };
}

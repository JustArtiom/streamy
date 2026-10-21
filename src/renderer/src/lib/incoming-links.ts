// Magnet links opened with Streamy from outside, e.g. clicked in a browser
// (see src/main/magnet-links.ts). A link can arrive before the page that
// handles it is ready, so the last one waits here until it's picked up.

type Listener = (link: string) => void;

let pending: string | null = null;
let current: Listener | null = null;

window.streamy.onMagnetLink((link) => {
  if (current) current(link);
  else pending = link;
});

/** Calls `onLink` for every magnet link opened with Streamy. */
export function onMagnetLinkOpened(onLink: Listener): () => void {
  current = onLink;
  if (pending !== null) {
    const link = pending;
    pending = null;
    onLink(link);
  }
  return () => {
    if (current === onLink) current = null;
  };
}

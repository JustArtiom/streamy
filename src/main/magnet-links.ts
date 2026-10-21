import { app, type WebContents } from "electron";
import { IpcChannel } from "../shared/api";

// Magnet links opened with Streamy (clicked in a browser, or from another
// app). They arrive in different ways:
// - macOS: the "open-url" event, even when the link launched the app.
// - Windows/Linux: as a command line argument, either of this launch or of a
//   second launch that the single-instance lock forwards to us.

/** Longest link we accept (real ones are far shorter; this is a sanity cap). */
const MAX_LENGTH = 16_384;

export function isMagnetLink(value: string): boolean {
  return value.length <= MAX_LENGTH && /^magnet:\?/i.test(value);
}

/** Finds a magnet link among command line arguments. */
export function findMagnetLink(argv: readonly string[]): string | undefined {
  return argv.find(isMagnetLink);
}

interface MagnetLinkOptions {
  /** Shows the main window (creating it if needed) and returns its contents. */
  showWindow: () => WebContents;
}

/**
 * Call before the app is ready: on macOS, a link that launches Streamy
 * arrives before "ready", and would be lost if nobody listened yet. Links
 * wait until `start()`, called once the app can show its window.
 */
export function receiveMagnetLinks({ showWindow }: MagnetLinkOptions): {
  start: () => void;
  /** Hand over links from a second launch (see "second-instance"). */
  fromArgv: (argv: readonly string[]) => void;
} {
  const pending: string[] = [];
  let started = false;

  const deliver = (link: string) => {
    const contents = showWindow();
    const send = () => {
      contents.send(IpcChannel.MagnetLinkOpened, link);
    };
    if (contents.isLoading()) contents.once("did-finish-load", send);
    else send();
  };

  const receive = (link: string) => {
    if (!isMagnetLink(link)) return;
    if (started) deliver(link);
    else pending.push(link);
  };

  app.on("open-url", (event, url) => {
    event.preventDefault();
    receive(url);
  });

  const fromArgv = (argv: readonly string[]) => {
    const link = findMagnetLink(argv);
    if (link) receive(link);
  };

  return {
    start: () => {
      started = true;
      fromArgv(process.argv); // Windows/Linux: the link that launched us
      for (const link of pending.splice(0)) deliver(link);
    },
    fromArgv,
  };
}

import { powerSaveBlocker, type WebContents } from "electron";
import { z } from "zod";
import { IpcChannel } from "../shared/api";
import { handleTrusted } from "./ipc";

// Keeps the screen awake while a video plays (PLAN §7.4). Each window says
// when it starts or stops playing; the screen may sleep again once none is
// playing. A window that closes, crashes or reloads counts as stopped, so a
// lost "false" can never keep the screen on forever.

/** Run once the app is ready. */
export function setupPlayerPower(): void {
  /** WebContents ids of the windows playing right now. */
  const playing = new Set<number>();
  /** Windows whose end we already watch for. */
  const watched = new Set<number>();
  let blockerId: number | null = null;

  const update = () => {
    if (playing.size > 0 && blockerId === null) {
      blockerId = powerSaveBlocker.start("prevent-display-sleep");
    } else if (playing.size === 0 && blockerId !== null) {
      powerSaveBlocker.stop(blockerId);
      blockerId = null;
    }
  };

  const stopped = (id: number) => {
    playing.delete(id);
    update();
  };

  const watch = (contents: WebContents) => {
    const { id } = contents;
    if (watched.has(id)) return;
    watched.add(id);
    contents.once("destroyed", () => {
      watched.delete(id);
      stopped(id);
    });
    contents.on("render-process-gone", () => {
      stopped(id);
    });
    // A reload or a new page (not the UI's own route changes).
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) stopped(id);
    });
  };

  handleTrusted(IpcChannel.SetPlaying, (event, value) => {
    const isPlaying = z.boolean().parse(value);
    const contents = event.sender;
    if (isPlaying) {
      watch(contents);
      playing.add(contents.id);
      update();
    } else {
      stopped(contents.id);
    }
  });
}

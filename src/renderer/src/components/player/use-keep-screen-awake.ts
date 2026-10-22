import { useEffect, useState } from "react";

/**
 * A window hidden this long (minimized, or covered by others) lets the
 * screen sleep, even if the video is still playing: nobody is watching
 * it. Short switches between apps don't count.
 */
export const HIDDEN_RELEASE_MS = 60_000;

/** True once the page has been hidden for `ms`; false again when shown. */
function useHiddenFor(ms: number): boolean {
  const [hiddenLong, setHiddenLong] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => {
          setHiddenLong(true);
        }, ms);
      } else {
        setHiddenLong(false);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [ms]);

  return hiddenLong;
}

/**
 * Keeps the screen from sleeping while `playing` (PLAN §7.4). The main
 * process holds a power-save blocker while any window says it plays. Every
 * "true" is followed by a "false": when playback stops (pause, end, error,
 * a session switch), when the player goes away, and when the window has
 * been hidden for a while. The main process also lets go when the window
 * closes or reloads, so a lost "false" can't keep the screen on.
 */
export function useKeepScreenAwake(playing: boolean): void {
  const hiddenLong = useHiddenFor(HIDDEN_RELEASE_MS);
  const awake = playing && !hiddenLong;

  useEffect(() => {
    if (!awake) return;
    send(true);
    return () => {
      send(false);
    };
  }, [awake]);
}

function send(playing: boolean) {
  window.streamy.player.setPlaying(playing).catch((error: unknown) => {
    console.error("Could not tell Streamy whether a video plays:", error);
  });
}

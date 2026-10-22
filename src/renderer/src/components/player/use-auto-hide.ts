import { useCallback, useEffect, useRef, useState } from "react";

export const HIDE_AFTER_MS = 3000;

/**
 * The controls fade out 3 s after the last mouse move while playing, and
 * stay while paused or while something holds them (an open menu, the
 * pointer resting on the controls).
 *
 * `keep` is asked whenever they're about to go: true keeps them a while
 * longer (keyboard focus on one of them, which a viewer must be able to
 * see). It must be a stable function.
 */
export function useAutoHide({
  playing,
  hold,
  keep,
}: {
  playing: boolean;
  hold: boolean;
  keep?: () => boolean;
}) {
  const [active, setActive] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** (Re)starts the countdown. */
  const hideLater = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    const tick = () => {
      if (keep?.()) {
        timer.current = setTimeout(tick, HIDE_AFTER_MS);
        return;
      }
      timer.current = null;
      setActive(false);
    };
    timer.current = setTimeout(tick, HIDE_AFTER_MS);
  }, [keep]);

  /** Show now, hide again after a while. */
  const poke = useCallback(() => {
    setActive(true);
    hideLater();
  }, [hideLater]);

  const hide = useCallback(() => {
    if (keep?.()) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setActive(false);
  }, [keep]);

  // Starting to play starts the countdown (without a mouse move).
  useEffect(() => {
    if (!playing) return;
    hideLater();
    return clear;
  }, [playing, hideLater]);

  // A countdown poked while paused mustn't outlive the player.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { visible: active || !playing || hold, poke, hide };
}

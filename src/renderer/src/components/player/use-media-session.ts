import { useEffect, useEffectEvent, useState } from "react";
import { engineUrl } from "@/lib/api";

// Media keys (play/pause, ⏪ ⏩, ⏮ ⏭ on keyboards and headphones) and the
// system's Now Playing (macOS Control Center, Windows' media overlay, MPRIS
// on Linux), through the browser's Media Session API.

export type MediaSessionActions = {
  play: () => void;
  pause: () => void;
  /** Movie time (s). */
  seekTo: (time: number) => void;
  /** Seconds, negative = back. */
  seekBy: (seconds: number) => void;
};

export type MediaSessionInput = {
  /** The file, e.g. "Sintel". */
  title: string;
  /** The torrent's name. */
  artist: string | null;
  /** A picture of the video ("/v1/…" from the engine), when there's one. */
  artworkPath: string | null;
  /** null = nothing to play or pause yet. */
  state: "playing" | "paused" | null;
  /** On the movie's timeline (not the session's), in seconds. */
  position: number;
  duration: number;
  rate: number;
  actions: MediaSessionActions;
  /** The previous / next video in the torrent, or null for none. */
  previous: (() => void) | null;
  next: (() => void) | null;
};

/** Seconds a ⏪/⏩ key skips when the system doesn't say. */
const DEFAULT_SEEK_OFFSET = 10;

type Action =
  | "play"
  | "pause"
  | "stop"
  | "seekbackward"
  | "seekforward"
  | "seekto"
  | "previoustrack"
  | "nexttrack";

const PLAYBACK_ACTIONS: Action[] = [
  "play",
  "pause",
  "stop",
  "seekbackward",
  "seekforward",
  "seekto",
];

function mediaSession(): MediaSession | null {
  return "mediaSession" in navigator ? navigator.mediaSession : null;
}

/** Some systems don't know every action: they throw for those. */
function setHandler(
  session: MediaSession,
  action: Action,
  handler: MediaSessionActionHandler | null,
) {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // Not supported here; nothing to set or unset.
  }
}

/**
 * The engine's picture as a blob: URL. The system's Now Playing only takes
 * http(s), data: and blob: pictures, not app:// ones.
 */
function useArtwork(path: string | null): string | null {
  const [artwork, setArtwork] = useState<{ path: string; url: string } | null>(
    null,
  );

  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let url: string | null = null;
    fetch(engineUrl(path), { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setArtwork({ path, url });
      })
      .catch(() => {
        // No picture, then: the title says enough.
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);

  return artwork?.path === path ? artwork.url : null;
}

export function useMediaSession(input: MediaSessionInput): void {
  const { title, artist, state, duration, rate } = input;
  const artwork = useArtwork(input.artworkPath);
  const hasPrevious = input.previous !== null;
  const hasNext = input.next !== null;
  // Whole seconds: the system moves the position along by itself (from
  // the rate); it only needs telling when it jumps.
  const second = Math.floor(input.position);

  // What the keys do, always with the latest player state.
  const onAction = useEffectEvent(
    (action: Action, details: MediaSessionActionDetails) => {
      const { actions } = input;
      switch (action) {
        case "play":
          actions.play();
          break;
        case "pause":
        case "stop":
          // "Stop" from a remote: pause, and stay on the movie.
          actions.pause();
          break;
        case "seekbackward":
          actions.seekBy(-(details.seekOffset ?? DEFAULT_SEEK_OFFSET));
          break;
        case "seekforward":
          actions.seekBy(details.seekOffset ?? DEFAULT_SEEK_OFFSET);
          break;
        case "seekto":
          if (details.seekTime !== undefined) actions.seekTo(details.seekTime);
          break;
        case "previoustrack":
          input.previous?.();
          break;
        case "nexttrack":
          input.next?.();
          break;
      }
    },
  );

  useEffect(() => {
    const session = mediaSession();
    if (!session) return;
    session.metadata = new MediaMetadata({
      title,
      artist: artist ?? "",
      artwork: artwork ? [{ src: artwork }] : [],
    });
    return () => {
      session.metadata = null;
    };
  }, [title, artist, artwork]);

  useEffect(() => {
    const session = mediaSession();
    if (!session) return;
    for (const action of PLAYBACK_ACTIONS) {
      setHandler(session, action, (details) => {
        onAction(action, details);
      });
    }
    return () => {
      for (const action of PLAYBACK_ACTIONS) setHandler(session, action, null);
    };
  }, []);

  // ⏮ ⏭ only when there's a video to go to: otherwise the system greys
  // them out.
  useEffect(() => {
    const session = mediaSession();
    if (!session) return;
    if (hasPrevious) {
      setHandler(session, "previoustrack", (details) => {
        onAction("previoustrack", details);
      });
    }
    if (hasNext) {
      setHandler(session, "nexttrack", (details) => {
        onAction("nexttrack", details);
      });
    }
    return () => {
      setHandler(session, "previoustrack", null);
      setHandler(session, "nexttrack", null);
    };
  }, [hasPrevious, hasNext]);

  useEffect(() => {
    const session = mediaSession();
    if (!session) return;
    session.playbackState = state ?? "none";
    return () => {
      session.playbackState = "none";
    };
  }, [state]);

  useEffect(() => {
    const session = mediaSession();
    if (!session || !(duration > 0) || !(rate > 0)) return;
    try {
      session.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(Math.max(0, second), duration),
      });
    } catch {
      // A value the system refused (e.g. a duration not known yet).
    }
  }, [duration, rate, second]);

  // Gone with the player: no stale slider in Now Playing.
  useEffect(
    () => () => {
      try {
        mediaSession()?.setPositionState();
      } catch {
        // Nothing to clear.
      }
    },
    [],
  );
}

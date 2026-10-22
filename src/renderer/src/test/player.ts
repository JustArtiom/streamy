import { act, fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import type { MediaInfo, Playback } from "../../../shared/engine-api";
import { HASH } from "@/test/fixtures";

// jsdom has <video> elements but can't play anything, and has neither the
// Fullscreen nor the Media Session API. These stand-ins behave just enough
// like Chromium for the player's tests.

function setPaused(element: HTMLMediaElement, paused: boolean) {
  Object.defineProperty(element, "paused", {
    configurable: true,
    get: () => paused,
  });
}

/**
 * play() and pause() flip `paused` and fire the events a browser would;
 * load() does nothing. Restored after each test (restoreMocks).
 */
export function stubMediaElements(): void {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    setPaused(this, false);
    this.dispatchEvent(new Event("play"));
    this.dispatchEvent(new Event("playing"));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    if (this.paused) return;
    setPaused(this, true);
    this.dispatchEvent(new Event("pause"));
  });
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {
    // Nothing to load in a test.
  });
}

/** The player's <video>. */
export function playerVideo(): HTMLVideoElement {
  const video = document.querySelector<HTMLVideoElement>(
    '[data-testid="player"] video',
  );
  if (!video) throw new Error("No player on screen");
  return video;
}

/** The video can play now (the engine then plays it). */
export function videoCanPlay(video = playerVideo()): void {
  act(() => {
    fireEvent(video, new Event("loadedmetadata"));
    fireEvent(video, new Event("canplay"));
  });
}

/** Element.requestFullscreen / document.exitFullscreen, as in Chromium. */
export function installFullscreen(): () => void {
  let element: Element | null = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => element,
  });
  const enter = (target: Element) => {
    element = target;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
  Element.prototype.requestFullscreen = function (this: Element) {
    return enter(this);
  };
  document.exitFullscreen = () => {
    element = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
  return () => {
    element = null;
    // @ts-expect-error -- jsdom has none: put it back the way it was.
    delete Element.prototype.requestFullscreen;
    // @ts-expect-error -- as above.
    delete document.exitFullscreen;
    // @ts-expect-error -- as above.
    delete document.fullscreenElement;
  };
}

/** navigator.mediaSession as the system sees it. */
export class FakeMediaSession {
  metadata: { title: string; artist: string; artwork: unknown[] } | null = null;
  playbackState: MediaSessionPlaybackState = "none";
  readonly handlers = new Map<string, MediaSessionActionHandler>();
  setActionHandler(action: string, handler: MediaSessionActionHandler | null) {
    if (handler) this.handlers.set(action, handler);
    else this.handlers.delete(action);
  }
  setPositionState = vi.fn();
  /** A media key or the Now Playing widget. */
  press(action: string, details: Partial<MediaSessionActionDetails> = {}) {
    const handler = this.handlers.get(action);
    if (!handler) throw new Error(`No handler for ${action}`);
    act(() => {
      handler({ action, ...details } as MediaSessionActionDetails);
    });
  }
}

export function installMediaSession(): {
  session: FakeMediaSession;
  uninstall: () => void;
} {
  const session = new FakeMediaSession();
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session,
  });
  const scope = globalThis as { MediaMetadata?: unknown };
  // new MediaMetadata(init) → an object with init's fields.
  scope.MediaMetadata = function MediaMetadata(
    this: Record<string, unknown>,
    init: object,
  ) {
    Object.assign(this, init);
  };
  return {
    session,
    uninstall: () => {
      // @ts-expect-error -- jsdom has none: put it back the way it was.
      delete navigator.mediaSession;
      delete scope.MediaMetadata;
    },
  };
}

/** A 1280×720 MP4 with two audio tracks and two subtitles. */
export function mediaInfo(overrides: Partial<MediaInfo> = {}): MediaInfo {
  return {
    duration: 888,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    bitRate: 2_000_000,
    video: {
      codec: "h264",
      profile: "High",
      width: 1280,
      height: 720,
      fps: 24,
      bitDepth: 8,
      hdr: false,
    },
    audioTracks: [
      {
        index: 0,
        codec: "aac",
        channels: 2,
        language: "en",
        title: null,
        isDefault: true,
      },
      {
        index: 1,
        codec: "aac",
        channels: 6,
        language: "ja",
        title: null,
        isDefault: false,
      },
    ],
    subtitleTracks: [
      {
        id: "file:1",
        source: "file",
        codec: "subrip",
        language: "en",
        title: "Sintel.en.srt",
        isDefault: false,
        isForced: false,
        isText: true,
      },
      {
        id: "embedded:0",
        source: "embedded",
        codec: "subrip",
        language: "fr",
        title: null,
        isDefault: false,
        isForced: false,
        isText: true,
      },
    ],
    ...overrides,
  };
}

/** A direct-play session: the browser plays the torrent's file itself. */
export function directPlayback(overrides: Partial<Playback> = {}): Playback {
  return {
    id: "p1",
    mode: "direct",
    reason: "An MP4 this system plays as it is",
    url: `/v1/torrents/${HASH}/files/0/stream`,
    offset: 0,
    duration: 888,
    output: { videoCodec: "h264", audioCodec: "aac", width: 1280, height: 720 },
    encoder: null,
    ...overrides,
  };
}

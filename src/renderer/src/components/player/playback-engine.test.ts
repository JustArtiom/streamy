import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreatePlaybackRequest,
  FileProgress,
  MediaInfo,
  Playback,
  PlaybackStatus,
} from "../../../../shared/engine-api";
import type { HlsAdapter, HlsSupport } from "@/components/player/hls-adapter";
import {
  type EngineApi,
  type EngineConnection,
  PlaybackEngine,
} from "@/components/player/playback-engine";
import type { FailureKind } from "@/components/player/playback-logic";
import { ApiRequestError, EngineUnavailableError } from "@/lib/api";

/** Just enough of a <video> for the engine (jsdom can't play media). */
class FakeVideo extends EventTarget {
  currentTime = 0;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  duration = NaN;
  error: { code: number } | null = null;
  private source: string | null = null;
  /** How many times a source was set (attach() sets one). */
  sourcesSet = 0;
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  canPlayType = vi.fn(() => "");
  set src(value: string) {
    this.source = value;
    this.sourcesSet += 1;
  }
  get src() {
    return this.source ?? "";
  }
  getAttribute(name: string) {
    return name === "src" ? this.source : null;
  }
  removeAttribute(name: string) {
    if (name === "src") this.source = null;
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
}

class FakeHls implements HlsAdapter {
  url: string | null = null;
  playlist: ((total: number) => void) | null = null;
  fatal: ((kind: FailureKind, details: string) => void) | null = null;
  load = vi.fn((url: string) => {
    this.url = url;
  });
  onPlaylist = (listener: (total: number) => void) => {
    this.playlist = listener;
  };
  onFatalError = (listener: (kind: FailureKind, details: string) => void) => {
    this.fatal = listener;
  };
  stopLoad = vi.fn();
  recoverMediaError = vi.fn();
  destroy = vi.fn();
  readonly startPosition: number;
  constructor(startPosition: number) {
    this.startPosition = startPosition;
  }
}

const media: MediaInfo = {
  duration: 600,
  container: "matroska,webm",
  bitRate: null,
  video: {
    codec: "h264",
    profile: "High",
    width: 1920,
    height: 1080,
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
  ],
  subtitleTracks: [
    {
      id: "embedded:0",
      source: "embedded",
      codec: "subrip",
      language: "en",
      title: null,
      isDefault: false,
      isForced: false,
      isText: true,
    },
    {
      id: "embedded:1",
      source: "embedded",
      codec: "hdmv_pgs_subtitle",
      language: "fr",
      title: null,
      isDefault: false,
      isForced: false,
      isText: false,
    },
    {
      id: "file:3",
      source: "file",
      codec: "subrip",
      language: "de",
      title: null,
      isDefault: false,
      isForced: false,
      isText: true,
    },
  ],
};

function playback(patch: Partial<Playback> = {}): Playback {
  return {
    id: "s1",
    mode: "remux",
    reason: "test",
    url: "/v1/playback/s1/index.m3u8",
    offset: 0,
    duration: 600,
    output: {
      videoCodec: "h264",
      audioCodec: "aac",
      width: 1920,
      height: 1080,
    },
    encoder: "copy",
    ...patch,
  };
}

const capabilities = {
  video: {
    h264: true,
    h264High10: false,
    hevc: false,
    hevcMain10: false,
    av1: false,
    vp9: true,
  },
  audio: {
    aac: true,
    mp3: true,
    opus: true,
    flac: true,
    ac3: false,
    eac3: false,
  },
  direct: { mp4: true, webm: true },
};

/** The engine process going away and coming back, under the test's control. */
class FakeConnection implements EngineConnection {
  down = false;
  private readonly listeners = new Set<() => void>();
  isDown = () => this.down;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(down: boolean) {
    this.down = down;
    for (const listener of this.listeners) listener();
  }
}

function setup(
  options: {
    start?: number;
    sessions?: Playback[];
    createPlayback?: EngineApi["createPlayback"];
    raw?: boolean;
  } = {},
) {
  const sessions = [...(options.sessions ?? [playback()])];
  const requests: CreatePlaybackRequest[] = [];
  const api = {
    createPlayback: vi.fn(
      options.createPlayback ??
        ((request: CreatePlaybackRequest) => {
          requests.push(request);
          const next =
            sessions.shift() ?? playback({ id: `extra${requests.length}` });
          return Promise.resolve(next);
        }),
    ),
    heartbeat: vi.fn((): Promise<PlaybackStatus> =>
      Promise.resolve({ state: "running", producedUntil: 120, error: null }),
    ),
    deletePlayback: vi.fn(() => Promise.resolve(undefined)),
    deletePlayer: vi.fn(() => Promise.resolve(undefined)),
    saveProgress: vi.fn((): Promise<FileProgress> =>
      Promise.reject(new ApiRequestError(404, "NOT_FOUND", "Not yet")),
    ),
  } satisfies EngineApi;
  const hlsInstances: FakeHls[] = [];
  const hls: HlsSupport = {
    isSupported: () => true,
    create: (startPosition) => {
      const instance = new FakeHls(startPosition);
      hlsInstances.push(instance);
      return instance;
    },
  };
  const onNotice = vi.fn();
  const onProgressSaved = vi.fn();
  const connection = new FakeConnection();
  const reopenTorrent = vi.fn(() => Promise.resolve());
  const engine = new PlaybackEngine({
    infoHash: "a".repeat(40),
    fileIndex: 0,
    media,
    raw: options.raw,
    capabilities,
    selection: { audioTrack: null, subtitleId: null, quality: "original" },
    start: options.start ?? 0,
    api,
    hls,
    connection,
    reopenTorrent,
    onNotice,
    onProgressSaved,
  });
  const video = new FakeVideo();
  const element = video as unknown as HTMLVideoElement;
  return {
    engine,
    video,
    element,
    api,
    requests,
    hlsInstances,
    onNotice,
    onProgressSaved,
    connection,
    reopenTorrent,
  };
}

/** Lets timers and promise callbacks run. */
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlaybackEngine: starting", () => {
  it("creates one session even when mounted twice (React StrictMode)", async () => {
    const { engine, element, api } = setup();

    engine.mount(element);
    engine.unmount();
    engine.mount(element);
    await flush();

    expect(api.createPlayback).toHaveBeenCalledTimes(1);
    expect(api.deletePlayback).not.toHaveBeenCalled();
    // The first mount never asked for anything: nothing to stop.
    expect(api.deletePlayer).not.toHaveBeenCalled();
    engine.unmount();
  });

  it("starts hls.js at session time (start - offset) and keeps the movie timeline", async () => {
    const { engine, element, video, requests, hlsInstances } = setup({
      start: 23,
      sessions: [playback({ offset: 20 })],
    });
    engine.mount(element);
    await flush();

    expect(requests[0]).toMatchObject({ start: 23, replaces: null });
    const hls = hlsInstances[0];
    expect(hls?.startPosition).toBe(3);
    expect(hls?.url).toBe("app://streamy/api/v1/playback/s1/index.m3u8");
    // Until the first frames, the target is the position.
    expect(engine.getSnapshot().phase).toBe("loading");
    expect(engine.getMovieTime()).toBe(23);

    video.currentTime = 3;
    video.fire("canplay");
    expect(engine.getSnapshot().phase).toBe("ready");
    expect(video.play).toHaveBeenCalled();

    video.currentTime = 7.5;
    expect(engine.getMovieTime()).toBe(27.5);
    engine.unmount();
  });

  it("plays direct sessions from the stream URL and jumps to the start", async () => {
    const { engine, element, video } = setup({
      start: 42,
      sessions: [
        playback({
          mode: "direct",
          url: "/v1/torrents/x/files/0/stream",
          encoder: null,
        }),
      ],
    });
    engine.mount(element);
    await flush();

    expect(video.src).toBe("app://streamy/api/v1/torrents/x/files/0/stream");
    video.fire("loadedmetadata");
    expect(video.currentTime).toBe(42);
    video.fire("canplay");
    expect(engine.getSnapshot().phase).toBe("ready");
    engine.unmount();
  });

  it("explains why a session couldn't start (503)", async () => {
    const { engine, element } = setup({
      createPlayback: () =>
        Promise.reject(
          new ApiRequestError(
            503,
            "SERVICE_UNAVAILABLE",
            "Too many videos are being converted right now",
          ),
        ),
    });
    engine.mount(element);
    await flush();

    expect(engine.getSnapshot()).toMatchObject({
      phase: "error",
      error: {
        kind: "playback",
        message: "Too many videos are being converted right now",
      },
    });
    // Busy isn't a format problem: no converting instead.
    expect(engine.getSnapshot().forceMode).toBeNull();
    engine.unmount();
  });

  it("says the torrent was removed on a 404 it can't fix", async () => {
    const { engine, element, reopenTorrent } = setup({
      createPlayback: () =>
        Promise.reject(new ApiRequestError(404, "NOT_FOUND", "Not found")),
    });
    engine.mount(element);
    await flush();

    // Opened again once (it may only have stopped), then it gives up.
    expect(reopenTorrent).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().error?.kind).toBe("removed");
    engine.unmount();
  });

  it("opens a torrent that stopped again, then starts", async () => {
    let calls = 0;
    const { engine, element, reopenTorrent } = setup({
      createPlayback: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              new ApiRequestError(404, "NOT_FOUND", "Torrent not found"),
            )
          : Promise.resolve(playback({ id: "s2" }));
      },
    });
    engine.mount(element);
    await flush();

    expect(reopenTorrent).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "loading",
      session: { id: "s2" },
    });
    engine.unmount();
  });
});

/** A remux session at offset 20 that's ready and has produced up to 50 s. */
async function playing(sessions?: Playback[]) {
  const context = setup({
    start: 23,
    sessions: sessions ?? [
      playback({ offset: 20 }),
      playback({ id: "s2", offset: 70 }),
    ],
  });
  context.engine.mount(context.element);
  await flush();
  context.video.currentTime = 3;
  context.video.fire("canplay");
  context.hlsInstances[0]?.playlist?.(30);
  return context;
}

describe("PlaybackEngine: seeking", () => {
  it("seeks inside what the session produced without a new session", async () => {
    const { engine, video, api } = await playing();
    expect(engine.getSnapshot().producedUntil).toBe(50);

    engine.seek(40);
    await flush(1000);

    expect(video.currentTime).toBe(20);
    expect(api.createPlayback).toHaveBeenCalledTimes(1);
    engine.unmount();
  });

  it("starts a new session (replacing the old one) for a far seek", async () => {
    const { engine, requests, hlsInstances } = await playing();

    engine.seek(72);
    // Shows the target at once; the session follows a moment later.
    expect(engine.getMovieTime()).toBe(72);
    await flush(400);

    expect(requests[1]).toMatchObject({ start: 72, replaces: "s1" });
    expect(hlsInstances[0]?.destroy).toHaveBeenCalled();
    expect(hlsInstances[1]?.startPosition).toBe(2);
    engine.unmount();
  });

  it("starts one session for a burst of far seeks", async () => {
    const { engine, requests } = await playing();

    engine.seek(100);
    engine.seek(200);
    engine.seek(300);
    await flush(400);

    expect(requests).toHaveLength(2);
    expect(requests[1]?.start).toBe(300);
    engine.unmount();
  });

  it("deletes a session that arrives after it was superseded", async () => {
    let resolveFirst: (value: Playback) => void = () => undefined;
    const signals: AbortSignal[] = [];
    let calls = 0;
    const { engine, element, api } = setup({
      createPlayback: (_request, signal) => {
        calls += 1;
        if (signal) signals.push(signal);
        if (calls === 1) {
          // A server that ignores the abort and answers anyway.
          return new Promise<Playback>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(playback({ id: "s2" }));
      },
    });
    engine.mount(element);
    await flush();

    engine.seek(300);
    await flush(400);
    expect(signals[0]?.aborted).toBe(true);

    resolveFirst(playback({ id: "late" }));
    await flush();

    expect(api.deletePlayback).toHaveBeenCalledWith("late");
    expect(engine.getSnapshot().session?.id).toBe("s2");
    engine.unmount();
  });
});

describe("PlaybackEngine: falling back", () => {
  it("repackages when the browser can't play the file directly", async () => {
    const { engine, element, video, requests, onNotice } = setup({
      sessions: [
        playback({ id: "d1", mode: "direct", url: "/v1/stream", offset: 0 }),
        playback({ id: "r1" }),
      ],
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");

    video.currentTime = 12;
    video.error = { code: 4 };
    video.fire("error");
    await flush();

    expect(requests[1]).toMatchObject({
      forceMode: "remux",
      start: 12,
      replaces: "d1",
    });
    expect(onNotice).toHaveBeenCalledWith("Switched to converted playback");
    engine.unmount();
  });

  it("lets hls.js recover once, then converts the video", async () => {
    const { engine, hlsInstances, requests } = await playing([
      playback({ offset: 20 }),
      playback({ id: "t1", mode: "transcode", offset: 20 }),
    ]);
    const hls = hlsInstances[0];

    hls?.fatal?.("media", "bufferAppendError");
    expect(hls?.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);

    hls?.fatal?.("media", "bufferAppendError");
    await flush();
    expect(requests[1]?.forceMode).toBe("transcode");
    // Later sessions stay converted (e.g. after a far seek).
    expect(engine.getSnapshot().forceMode).toBe("transcode");
    engine.unmount();
  });

  it("gives up with Retry when the converted video fails too", async () => {
    const { engine, element, video, hlsInstances, requests } = setup({
      sessions: [
        playback({ id: "t1", mode: "transcode" }),
        playback({ id: "t2", mode: "transcode" }),
      ],
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");

    hlsInstances[0]?.fatal?.("media", "x");
    hlsInstances[0]?.fatal?.("media", "x");
    expect(engine.getSnapshot().phase).toBe("error");

    engine.retry();
    await flush();
    expect(requests).toHaveLength(2);
    expect(engine.getSnapshot().phase).toBe("loading");
    engine.unmount();
  });
});

describe("PlaybackEngine: edge cases", () => {
  it("retries from where it failed, not from the session start", async () => {
    const { engine, video, hlsInstances, requests } = await playing([
      playback({ offset: 20 }),
      playback({ id: "t1", mode: "transcode", offset: 20 }),
      playback({ id: "t2", mode: "transcode", offset: 20 }),
    ]);
    video.currentTime = 15;
    hlsInstances[0]?.fatal?.("media", "x");
    hlsInstances[0]?.fatal?.("media", "x");
    await flush();
    video.fire("canplay");

    // The transcode fails too; hls.js detaching resets the video to 0.
    hlsInstances[1]?.fatal?.("media", "x");
    hlsInstances[1]?.fatal?.("media", "x");
    video.currentTime = 0;
    expect(engine.getSnapshot().phase).toBe("error");
    expect(engine.getMovieTime()).toBe(35);

    engine.retry();
    await flush();
    expect(requests.at(-1)?.start).toBe(35);
    engine.unmount();
  });

  it("drops a session that's still starting when the viewer seeks elsewhere", async () => {
    let resolveFirst: (value: Playback) => void = () => undefined;
    let calls = 0;
    const { engine, element, video, api } = setup({
      createPlayback: () => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Playback>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(playback({ id: "s2" }));
      },
    });
    engine.mount(element);
    await flush();

    engine.seek(200);
    // The first answer lands inside the debounce window: never played.
    resolveFirst(playback({ id: "early" }));
    await flush();
    video.fire("canplay");
    expect(engine.getSnapshot().phase).toBe("preparing");
    expect(engine.getMovieTime()).toBe(200);
    expect(api.deletePlayback).toHaveBeenCalledWith("early");

    await flush(400);
    expect(engine.getSnapshot().session?.id).toBe("s2");
    engine.unmount();
  });

  it("asks again when an embedded text subtitle is picked during the first start", async () => {
    let resolveFirst: (value: Playback) => void = () => undefined;
    const requests: CreatePlaybackRequest[] = [];
    const { engine, element } = setup({
      createPlayback: (request) => {
        requests.push(request);
        if (requests.length === 1) {
          return new Promise<Playback>((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve(playback({ id: "r1" }));
      },
    });
    engine.mount(element);
    await flush();

    engine.setSubtitle("embedded:0");
    resolveFirst(playback({ id: "d1", mode: "direct", url: "/v1/s" }));
    await flush();

    expect(requests[1]).toMatchObject({ embeddedSubtitles: true });
    expect(engine.getSnapshot().session?.id).toBe("r1");
    engine.unmount();
  });

  it("doesn't restart when the default audio track is picked again", async () => {
    const { engine, requests } = await playing();

    engine.setAudioTrack(0);
    await flush();

    expect(requests).toHaveLength(1);
    engine.unmount();
  });
});

describe("PlaybackEngine: choices", () => {
  it("restarts for an audio or quality change, at the current time", async () => {
    const { engine, video, requests } = await playing();
    video.currentTime = 10;

    engine.setQuality("720p");
    await flush();

    expect(requests[1]).toMatchObject({
      quality: "720p",
      start: 30,
      replaces: "s1",
    });
    engine.unmount();
  });

  it("doesn't restart for text subtitles an HLS session already has", async () => {
    const { engine, requests } = await playing();

    engine.setSubtitle("embedded:0");
    engine.setSubtitle("file:3");
    engine.setSubtitle(null);
    await flush();

    expect(requests).toHaveLength(1);
    engine.unmount();
  });

  it("burns in picture subtitles, and restarts again to remove them", async () => {
    const { engine, requests } = await playing();

    engine.setSubtitle("embedded:1");
    await flush();
    expect(requests[1]).toMatchObject({ burnSubtitle: "embedded:1" });

    engine.setSubtitle(null);
    await flush();
    expect(requests[2]).toMatchObject({ burnSubtitle: null });
    engine.unmount();
  });

  it("asks for a remux to show embedded text subtitles of a direct file", async () => {
    const { engine, element, video, requests } = setup({
      sessions: [playback({ id: "d1", mode: "direct", url: "/v1/s" })],
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");

    engine.setSubtitle("file:3");
    await flush();
    expect(requests).toHaveLength(1);

    engine.setSubtitle("embedded:0");
    await flush();
    expect(requests[1]).toMatchObject({
      embeddedSubtitles: true,
      replaces: "d1",
    });
    engine.unmount();
  });
});

describe("PlaybackEngine: keeping the session alive", () => {
  it("sends the movie time every 5 s and learns how far ffmpeg got", async () => {
    const { engine, video, api } = await playing();
    video.currentTime = 4;
    video.paused = false;

    await flush(5000);

    expect(api.heartbeat).toHaveBeenCalledWith("s1", {
      position: 24,
      paused: false,
      subtitle: null,
    });
    expect(engine.getSnapshot().producedUntil).toBe(120);
    engine.unmount();
  });

  it("stops the session when the player closes", async () => {
    const { engine, api } = await playing();

    engine.unmount();

    expect(api.deletePlayback).toHaveBeenCalledWith("s1");
  });

  it("stops the session when the page goes away", async () => {
    const { engine, api } = await playing();

    window.dispatchEvent(new Event("pagehide"));
    expect(api.deletePlayback).toHaveBeenCalledWith("s1");
    expect(api.deletePlayer).toHaveBeenCalledTimes(1);

    // ...and doesn't delete it a second time on unmount.
    engine.unmount();
    expect(api.deletePlayback).toHaveBeenCalledTimes(1);
    expect(api.deletePlayer).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh session when the server forgot this one", async () => {
    const { engine, api, requests } = await playing();
    api.heartbeat.mockRejectedValueOnce(
      new ApiRequestError(404, "NOT_FOUND", "Unknown session"),
    );

    await flush(5000);

    expect(requests).toHaveLength(2);
    // The old one is gone on the server: nothing to replace.
    expect(requests[1]?.replaces).toBeNull();
    engine.unmount();
  });
});

describe("PlaybackEngine: play/pause wish", () => {
  it("plays again from the movie's start after the end", async () => {
    const { engine, video, requests } = await playing();
    video.ended = true;

    engine.togglePlay();
    await flush();

    // The session began at 20 s: the start needs a new one.
    expect(requests[1]).toMatchObject({ start: 0, replaces: "s1" });
    expect(engine.getSnapshot().playIntent).toBe(true);
    engine.unmount();
  });

  it("remembers play/pause while a session is starting", async () => {
    const { engine, element, video } = setup();
    engine.mount(element);
    engine.togglePlay();
    expect(engine.getSnapshot().playIntent).toBe(false);
    await flush();

    video.fire("canplay");
    expect(video.play).not.toHaveBeenCalled();
    engine.unmount();
  });

  it("shows a play button when the browser refuses autoplay", async () => {
    const { engine, element, video } = setup();
    video.play.mockImplementationOnce(() =>
      Promise.reject(new DOMException("blocked", "NotAllowedError")),
    );
    engine.mount(element);
    await flush();
    video.fire("canplay");
    await flush();

    expect(engine.getSnapshot()).toMatchObject({
      playIntent: false,
      autoplayBlocked: true,
    });
    engine.unmount();
  });
});

describe("PlaybackEngine: the library", () => {
  it("sends the subtitle shown with each heartbeat", async () => {
    const { engine, api } = await playing();

    engine.setSubtitle("file:3");
    await flush(5000);

    expect(api.heartbeat).toHaveBeenLastCalledWith(
      "s1",
      expect.objectContaining({ subtitle: "file:3" }),
    );
    engine.unmount();
  });

  it("saves the position once when the player closes", async () => {
    const { engine, video, api, onProgressSaved } = await playing();
    api.saveProgress.mockResolvedValue({} as FileProgress);
    engine.setSubtitle("file:3");
    video.currentTime = 10;

    engine.unmount();
    await flush();

    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(api.saveProgress).toHaveBeenCalledWith(
      "a".repeat(40),
      0,
      { position: 30, duration: 600, audioTrack: null, subtitle: "file:3" },
      { keepalive: true },
    );
    expect(onProgressSaved).toHaveBeenCalled();
  });

  it("saves on pagehide (the window closing), and not again on unmount", async () => {
    const { engine, api } = await playing();

    window.dispatchEvent(new Event("pagehide"));
    engine.unmount();

    expect(api.saveProgress).toHaveBeenCalledTimes(1);
    expect(api.saveProgress).toHaveBeenCalledWith(
      "a".repeat(40),
      0,
      expect.objectContaining({ position: 23 }),
      { keepalive: true },
    );
  });

  it("doesn't save a position that never played", async () => {
    const { engine, element, api } = setup({ start: 300 });
    engine.mount(element);
    await flush();

    engine.unmount();

    expect(api.saveProgress).not.toHaveBeenCalled();
  });

  it("doesn't mind a library that doesn't know the file (404)", async () => {
    const { engine, api, onProgressSaved } = await playing();

    engine.unmount();
    await flush();

    expect(api.saveProgress).toHaveBeenCalled();
    expect(onProgressSaved).not.toHaveBeenCalled();
  });

  it("saves the end of the movie when it ends, so it counts as watched", async () => {
    const { engine, video, api } = await playing();
    video.currentTime = 580;
    video.fire("ended");

    expect(api.saveProgress).toHaveBeenCalledWith(
      "a".repeat(40),
      0,
      expect.objectContaining({ position: 600, duration: 600 }),
      { keepalive: false },
    );

    // Leaving right after: nothing new to save.
    engine.unmount();
    expect(api.saveProgress).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackEngine: engine restarts", () => {
  it("waits on the last frame while the engine restarts, then starts again there", async () => {
    const { engine, video, api, requests, connection, hlsInstances } =
      await playing();
    video.paused = false;
    video.currentTime = 10;

    connection.set(true);

    expect(engine.getSnapshot().phase).toBe("reconnecting");
    expect(engine.getMovieTime()).toBe(30);
    expect(hlsInstances[0]?.stopLoad).toHaveBeenCalled();
    expect(video.pause).toHaveBeenCalled();
    // Still meant to play once it's back.
    expect(engine.getSnapshot().playIntent).toBe(true);
    // No heartbeats to an engine that isn't there.
    await flush(5000);
    expect(api.heartbeat).not.toHaveBeenCalled();

    connection.set(false);
    await flush();

    // The old session died with the engine: nothing to replace or delete.
    expect(requests[1]).toMatchObject({ start: 30, replaces: null });
    expect(api.deletePlayback).not.toHaveBeenCalled();
    expect(engine.getSnapshot().phase).toBe("loading");
    engine.unmount();
  });

  it("opens the torrent again when the restarted engine doesn't know it", async () => {
    let calls = 0;
    const { engine, element, video, connection, reopenTorrent } = setup({
      createPlayback: () => {
        calls += 1;
        if (calls === 2) {
          return Promise.reject(
            new ApiRequestError(404, "NOT_FOUND", "Torrent not found"),
          );
        }
        return Promise.resolve(playback({ id: `s${calls}` }));
      },
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");

    connection.set(true);
    connection.set(false);
    await flush();

    expect(reopenTorrent).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().session?.id).toBe("s3");
    engine.unmount();
  });

  it("reconnects instead of failing when a request finds no engine (503)", async () => {
    const { engine, element, connection, requests } = setup({
      createPlayback: (request) => {
        requests.push(request);
        if (requests.length > 1) return Promise.resolve(playback({ id: "s2" }));
        connection.down = true; // the status arrives with the error
        return Promise.reject(new EngineUnavailableError());
      },
    });
    engine.mount(element);
    await flush();

    expect(engine.getSnapshot().phase).toBe("reconnecting");
    expect(engine.getSnapshot().error).toBeNull();

    connection.set(false);
    await flush();
    expect(engine.getSnapshot().session?.id).toBe("s2");
    engine.unmount();
  });

  it("turns an error that came just before the engine stopped into reconnecting", async () => {
    const { engine, element, connection, requests } = setup({
      createPlayback: (request) => {
        requests.push(request);
        return requests.length === 1
          ? Promise.reject(
              new ApiRequestError(
                503,
                "SERVICE_UNAVAILABLE",
                "The playback engine isn't running.",
              ),
            )
          : Promise.resolve(playback({ id: "s2" }));
      },
    });
    engine.mount(element);
    await flush();
    expect(engine.getSnapshot().phase).toBe("error");

    connection.set(true);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "reconnecting",
      error: null,
    });

    connection.set(false);
    await flush();
    expect(engine.getSnapshot().session?.id).toBe("s2");
    engine.unmount();
  });

  it("reconnects when hls.js loses the stream because the engine stopped", async () => {
    const { engine, hlsInstances, connection, requests } = await playing();

    connection.down = true;
    hlsInstances[0]?.fatal?.("network", "fragLoadError");

    expect(engine.getSnapshot().phase).toBe("reconnecting");
    expect(requests).toHaveLength(1);
    engine.unmount();
  });

  it("tries again a few times when the engine is said to run but doesn't answer", async () => {
    const { engine, element, requests } = setup({
      createPlayback: (request) => {
        requests.push(request);
        return Promise.reject(new EngineUnavailableError());
      },
    });
    engine.mount(element);
    await flush();
    expect(engine.getSnapshot().phase).toBe("reconnecting");

    await flush(3000);
    await flush(3000);
    await flush(3000);

    expect(requests).toHaveLength(4);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "error",
      error: { title: "Lost the video stream" },
    });
    engine.unmount();
  });

  it("remembers seeks and track choices made while reconnecting", async () => {
    const { engine, requests, connection } = await playing();

    connection.set(true);
    engine.seek(300);
    engine.setAudioTrack(null);
    engine.setQuality("720p");
    await flush(1000);
    expect(requests).toHaveLength(1);

    connection.set(false);
    await flush();
    expect(requests[1]).toMatchObject({ start: 300, quality: "720p" });
    engine.unmount();
  });

  it("waits for the engine before the first start", async () => {
    const { engine, element, connection, requests } = setup({ start: 42 });
    connection.down = true;
    engine.mount(element);
    await flush();

    expect(engine.getSnapshot().phase).toBe("reconnecting");
    expect(requests).toHaveLength(0);

    connection.set(false);
    await flush();
    expect(requests[0]).toMatchObject({ start: 42 });
    engine.unmount();
  });

  it("plays the file again after a restart without ffmpeg (raw)", async () => {
    const { engine, element, video, connection, reopenTorrent, api } = setup({
      raw: true,
      start: 0,
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");
    video.currentTime = 50;

    connection.set(true);
    video.src = "";
    connection.set(false);
    await flush();

    expect(reopenTorrent).toHaveBeenCalled();
    expect(video.src).toBe(
      `app://streamy/api/v1/torrents/${"a".repeat(40)}/files/0/stream`,
    );
    expect(engine.getMovieTime()).toBe(50);
    expect(api.createPlayback).not.toHaveBeenCalled();
    engine.unmount();
  });
});

describe("PlaybackEngine: media keys", () => {
  it("plays and pauses rather than toggling", async () => {
    const { engine, video } = await playing();
    video.paused = false;

    engine.play();
    expect(video.pause).not.toHaveBeenCalled();
    engine.pause();
    expect(video.pause).toHaveBeenCalledTimes(1);
    engine.pause();
    expect(video.pause).toHaveBeenCalledTimes(1);
    engine.play();
    expect(video.play).toHaveBeenCalledTimes(2);
    engine.unmount();
  });
});

describe("PlaybackEngine: a torrent that isn't ready yet", () => {
  it("asks again while the file list isn't known (409), then plays", async () => {
    let calls = 0;
    const { engine, element } = setup({
      createPlayback: () => {
        calls += 1;
        return calls < 3
          ? Promise.reject(
              new ApiRequestError(
                409,
                "CONFLICT",
                "The torrent's file list isn't known yet. Try again in a moment.",
              ),
            )
          : Promise.resolve(playback({ id: "s3" }));
      },
    });
    engine.mount(element);
    await flush();
    expect(engine.getSnapshot()).toMatchObject({ phase: "preparing" });

    await flush(1000);
    await flush(1000);

    expect(calls).toBe(3);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "loading",
      error: null,
      session: { id: "s3" },
    });
    engine.unmount();
  });

  it("stops asking when the viewer leaves", async () => {
    const { engine, element, api } = setup({
      createPlayback: () =>
        Promise.reject(new ApiRequestError(409, "CONFLICT", "Not yet")),
    });
    engine.mount(element);
    await flush();

    engine.unmount();
    await flush(5000);

    expect(api.createPlayback).toHaveBeenCalledTimes(1);
  });
});

describe("PlaybackEngine: one player, one id", () => {
  it("sends the same player id with every start, and stops the player when it closes", async () => {
    const { engine, api, requests } = await playing();

    engine.seek(300);
    await flush(400);

    const playerId = requests[0]?.playerId;
    expect(playerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]?.playerId).toBe(playerId);

    engine.unmount();
    // Stops a start still in progress too (aborting the fetch doesn't).
    expect(api.deletePlayer).toHaveBeenCalledWith(playerId);
  });

  it("stops a start still in progress when the player closes", async () => {
    const { engine, element, api } = setup({
      createPlayback: () => new Promise<Playback>(() => undefined),
    });
    engine.mount(element);
    await flush();

    engine.unmount();

    expect(api.deletePlayer).toHaveBeenCalledTimes(1);
  });

  it("picks a new id for each mount", async () => {
    const { engine, element, requests } = setup();
    engine.mount(element);
    await flush();
    engine.unmount();
    engine.mount(element);
    await flush();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.playerId).not.toBe(requests[0]?.playerId);
    engine.unmount();
  });
});

describe("PlaybackEngine: a start that ffmpeg can't make", () => {
  beforeEach(() => {
    // The engine's own words go to the console.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  const ffmpegFailed = () =>
    Promise.reject(
      new ApiRequestError(
        500,
        "INTERNAL",
        "The video couldn't be converted. ffmpeg stopped unexpectedly.",
      ),
    );

  it("converts the video when repackaging fails (500), then Retry works", async () => {
    const requests: CreatePlaybackRequest[] = [];
    const { engine, element, onNotice } = setup({
      createPlayback: (request) => {
        requests.push(request);
        return requests.length <= 2
          ? ffmpegFailed()
          : Promise.resolve(playback({ id: "t1", mode: "transcode" }));
      },
    });
    engine.mount(element);
    await flush();

    // Remux (the engine's choice) failed: converting, like a remux the
    // browser couldn't play.
    expect(requests[1]).toMatchObject({ forceMode: "transcode", start: 0 });
    expect(onNotice).toHaveBeenCalledWith("Switched to converted playback");
    // Converting failed too: nothing left to try.
    expect(requests).toHaveLength(2);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "error",
      error: {
        kind: "playback",
        message:
          "Converting it stopped unexpectedly. Try again, or pick a lower quality.",
      },
    });

    engine.retry();
    await flush();
    expect(requests[2]).toMatchObject({ forceMode: "transcode" });
    expect(engine.getSnapshot()).toMatchObject({
      phase: "loading",
      error: null,
      session: { id: "t1" },
    });
    engine.unmount();
  });

  it("converts when the repackaging that followed direct play fails to start", async () => {
    let calls = 0;
    const requests: CreatePlaybackRequest[] = [];
    const { engine, element, video } = setup({
      createPlayback: (request) => {
        requests.push(request);
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            playback({ id: "d1", mode: "direct", url: "/v1/s" }),
          );
        }
        return calls === 2
          ? ffmpegFailed()
          : Promise.resolve(playback({ id: "t1", mode: "transcode" }));
      },
    });
    engine.mount(element);
    await flush();
    video.fire("canplay");

    video.error = { code: 4 };
    video.fire("error");
    await flush();

    expect(requests.map((request) => request.forceMode)).toEqual([
      null,
      "remux",
      "transcode",
    ]);
    expect(engine.getSnapshot().session?.id).toBe("t1");
    engine.unmount();
  });
});

describe("PlaybackEngine: Retry after the torrent wasn't ready", () => {
  it("gives each new start its own two minutes of 409s", async () => {
    let ready = false;
    let calls = 0;
    const { engine, element } = setup({
      createPlayback: () => {
        calls += 1;
        return ready
          ? Promise.resolve(playback({ id: "s2" }))
          : Promise.reject(
              new ApiRequestError(409, "CONFLICT", "Checking the data"),
            );
      },
    });
    engine.mount(element);
    await flush();
    await flush(120_000);
    expect(engine.getSnapshot().phase).toBe("error");
    const afterWindow = calls;

    // Retry waits again instead of failing on the first 409...
    engine.retry();
    await flush(5000);
    expect(calls).toBe(afterWindow + 6);
    expect(engine.getSnapshot()).toMatchObject({
      phase: "preparing",
      error: null,
    });

    ready = true;
    await flush(1000);
    expect(engine.getSnapshot().session?.id).toBe("s2");
    engine.unmount();
  });

  it("lets a track change wait too, after the window ran out once", async () => {
    const { engine, element } = setup({
      createPlayback: () =>
        Promise.reject(new ApiRequestError(409, "CONFLICT", "Not yet")),
    });
    engine.mount(element);
    await flush();
    await flush(120_000);
    expect(engine.getSnapshot().phase).toBe("error");

    engine.setQuality("720p");
    await flush(3000);

    expect(engine.getSnapshot().phase).toBe("preparing");
    engine.unmount();
  });
});

describe("PlaybackEngine: seeking near the edge", () => {
  it("seeks past hls.js's playlist with a new session, even when the engine produced more", async () => {
    const { engine, video, requests } = await playing();
    // The heartbeat says 120 s exist; hls.js's playlist ends at 50 s.
    await flush(5000);
    expect(engine.getSnapshot().producedUntil).toBe(120);

    engine.seek(45);
    expect(video.currentTime).toBe(25);
    expect(requests).toHaveLength(1);

    // Past the playlist hls.js would jump back to its live edge.
    engine.seek(100);
    await flush(400);
    expect(requests[1]).toMatchObject({ start: 100, replaces: "s1" });
    engine.unmount();
  });
});

describe("PlaybackEngine: direct play after its session was forgotten", () => {
  const stream = "/v1/torrents/x/files/0/stream";
  const direct = (id: string) =>
    playback({ id, mode: "direct", url: stream, encoder: null });
  const forgotten = () =>
    new ApiRequestError(
      404,
      "NOT_FOUND",
      "This playback session doesn't exist",
    );

  async function directPlaying(createPlayback?: EngineApi["createPlayback"]) {
    const context = setup({
      sessions: [direct("d1"), direct("d2")],
      createPlayback,
    });
    context.engine.mount(context.element);
    await flush();
    context.video.fire("canplay");
    context.video.paused = false;
    return context;
  }

  it("gets a new id and keeps saving the position, without touching the video", async () => {
    const { engine, video, api, requests } = await directPlaying();
    video.currentTime = 300;
    api.heartbeat.mockRejectedValueOnce(forgotten());

    await flush(5000);

    expect(requests[1]).toMatchObject({
      start: 300,
      forceMode: "direct",
      replaces: null,
      playerId: requests[0]?.playerId,
    });
    expect(engine.getSnapshot()).toMatchObject({
      phase: "ready",
      session: { id: "d2" },
    });
    // Same source, no reload: the viewer notices nothing.
    expect(video.sourcesSet).toBe(1);
    expect(video.load).not.toHaveBeenCalled();
    expect(video.pause).not.toHaveBeenCalled();

    video.currentTime = 305;
    await flush(5000);
    expect(api.heartbeat).toHaveBeenLastCalledWith("d2", {
      position: 305,
      paused: false,
      subtitle: null,
    });
    engine.unmount();
  });

  it("opens the torrent again when it stopped too", async () => {
    let calls = 0;
    const { engine, api, reopenTorrent } = await directPlaying(() => {
      calls += 1;
      if (calls === 2) {
        return Promise.reject(
          new ApiRequestError(404, "NOT_FOUND", "Torrent not found"),
        );
      }
      return Promise.resolve(direct(`d${calls}`));
    });
    api.heartbeat.mockRejectedValueOnce(forgotten());

    await flush(5000);

    expect(reopenTorrent).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().session?.id).toBe("d3");
    engine.unmount();
  });

  it("tries a few times, then leaves it", async () => {
    let calls = 0;
    const { engine, api } = await directPlaying(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(direct("d1"))
        : Promise.reject(new ApiRequestError(500, "INTERNAL", "Oops"));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    api.heartbeat.mockRejectedValueOnce(forgotten());

    await flush(5000 * 6);

    expect(calls).toBe(4);
    // Still playing: renewing is a background chore.
    expect(engine.getSnapshot()).toMatchObject({ phase: "ready", error: null });
    engine.unmount();
  });

  it("drops a new id that arrives after the viewer switched sessions", async () => {
    let finishRenewal: (value: Playback) => void = () => undefined;
    let calls = 0;
    const { engine, api } = await directPlaying(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(direct("d1"));
      if (calls === 2) {
        return new Promise<Playback>((resolve) => {
          finishRenewal = resolve;
        });
      }
      return Promise.resolve(playback({ id: "t1", mode: "transcode" }));
    });
    api.heartbeat.mockRejectedValueOnce(forgotten());
    await flush(5000);

    engine.setQuality("720p");
    await flush();
    finishRenewal(direct("late"));
    await flush();

    expect(api.deletePlayback).toHaveBeenCalledWith("late");
    expect(engine.getSnapshot().session?.id).toBe("t1");
    engine.unmount();
  });

  it("gets a new id after coming back from the back/forward cache", async () => {
    const { engine, api, requests } = await directPlaying();

    window.dispatchEvent(new Event("pagehide"));
    expect(api.deletePlayback).toHaveBeenCalledWith("d1");
    // Nothing starts while the page is away.
    await flush(5000);
    expect(requests).toHaveLength(1);

    window.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: true }),
    );
    await flush(5000);

    expect(requests[1]).toMatchObject({ forceMode: "direct" });
    // A new player id: the old one was told to stop on pagehide.
    expect(requests[1]?.playerId).not.toBe(requests[0]?.playerId);
    expect(engine.getSnapshot().session?.id).toBe("d2");
    engine.unmount();
  });
});

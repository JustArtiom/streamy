import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreatePlaybackRequest,
  FileProgress,
  TorrentDetail,
} from "../../../shared/engine-api";
import { SUBTITLES_OFF } from "../../../shared/settings";
import { WatchPage } from "@/pages/watch";
import {
  type EngineAnswer,
  engineError,
  mockEngine,
  noContent,
} from "@/test/engine";
import { fakeStreamy, INITIAL_SNAPSHOT } from "@/test/fake-streamy";
import {
  continueItem,
  HASH,
  library,
  libraryTorrent,
  torrentDetail,
  torrentFile,
} from "@/test/fixtures";
import {
  directPlayback,
  type FakeMediaSession,
  installFullscreen,
  installMediaSession,
  mediaInfo,
  playerVideo,
  stubMediaElements,
  videoCanPlay,
} from "@/test/player";
import { renderWithProviders } from "@/test/render";

const TORRENT = `GET /v1/torrents/${HASH}`;
const LIBRARY = `GET /v1/library/${HASH}`;
const MEDIA = `GET /v1/torrents/${HASH}/files/0/media`;
const PLAYBACK = "POST /v1/playback";
const SAVE = `PUT /v1/library/${HASH}/files/0`;
/** The id the player sends with its starts (random in the app). */
const PLAYER_ID = "00000000-0000-4000-8000-000000000001";
const STOP_PLAYER = `DELETE /v1/players/${PLAYER_ID}`;

function progress(overrides: Partial<FileProgress> = {}): FileProgress {
  return {
    infoHash: HASH,
    fileIndex: 0,
    fileName: "Sintel.mp4",
    position: 2052,
    duration: 2400,
    audioTrack: 1,
    subtitle: "embedded:0",
    watched: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function apiError(status: number, message: string) {
  return engineError(
    status,
    status === 503 ? "SERVICE_UNAVAILABLE" : "BAD_REQUEST",
    message,
  );
}

/** An engine where Sintel.mp4 plays directly. */
function watchEngine(routes: Record<string, EngineAnswer> = {}) {
  return mockEngine({
    [TORRENT]: { torrent: torrentDetail() },
    // The library doesn't know it yet (or doesn't exist yet): no resume.
    [LIBRARY]: engineError(404, "NOT_FOUND", "Not in the library"),
    [MEDIA]: { media: mediaInfo() },
    [`GET /v1/torrents/${HASH}/files/1/subtitles`]: {
      cues: [{ start: 0, end: 600, text: "Hello there" }],
    },
    [PLAYBACK]: { playback: directPlayback() },
    "POST /v1/playback/p1/heartbeat": {
      status: { state: "running", producedUntil: null, error: null },
    },
    "DELETE /v1/playback/p1": noContent(),
    [SAVE]: { progress: progress() },
    // Continue watching (the library's picture of the video).
    "GET /v1/library": library(),
    // Sent when the player closes.
    [STOP_PLAYER]: noContent(),
    ...routes,
  });
}

function renderWatch(state?: { start?: "resume" | "beginning" }) {
  return renderWithProviders(<WatchPage />, {
    path: "/watch/:infoHash/:fileIndex",
    route: { pathname: `/watch/${HASH}/0`, state },
  });
}

function playbackRequests(engine: ReturnType<typeof mockEngine>) {
  return engine
    .callsTo(PLAYBACK)
    .map((call) => call.body as CreatePlaybackRequest);
}

function changeSettings(patch: Partial<typeof INITIAL_SNAPSHOT.settings>) {
  act(() => {
    fakeStreamy.emit({
      ...INITIAL_SNAPSHOT,
      settings: { ...INITIAL_SNAPSHOT.settings, ...patch },
    });
  });
}

/** Renders the page and waits until the video is playing. */
async function playing(
  routes: Record<string, EngineAnswer> = {},
  state?: { start?: "resume" | "beginning" },
) {
  const engine = watchEngine(routes);
  const view = renderWatch(state);
  await waitFor(() => {
    expect(playerVideo().getAttribute("src")).toContain("/stream");
  });
  videoCanPlay();
  return { ...view, engine };
}

beforeEach(() => {
  stubMediaElements();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(PLAYER_ID);
});

describe("before the player", () => {
  it("finds peers while the torrent has no file list yet", async () => {
    watchEngine({
      [TORRENT]: {
        torrent: torrentDetail({
          status: "fetching_metadata",
          files: [],
          peers: 3,
        }),
      },
      [MEDIA]: engineError(409, "CONFLICT", "The file list isn't known yet"),
    });
    renderWatch();

    expect(await screen.findByText("Finding peers…")).toBeVisible();
    expect(screen.getByText("3 peers so far")).toBeVisible();
  });

  it("checks the downloaded data, rather than finding peers", async () => {
    watchEngine({
      [TORRENT]: { torrent: torrentDetail({ status: "checking", peers: 0 }) },
      [MEDIA]: engineError(409, "CONFLICT", "Checking the downloaded data"),
    });
    renderWatch();

    expect(await screen.findByText("Checking downloaded data…")).toBeVisible();
    expect(screen.queryByText("Finding peers…")).toBeNull();
    expect(screen.queryByText(/Nobody seems to be sharing/)).toBeNull();
  });

  it("says the data is being checked when only the start waits for it", async () => {
    // The video's info was known already (ffprobe ran before a restart).
    watchEngine({
      [TORRENT]: { torrent: torrentDetail({ status: "checking" }) },
      [PLAYBACK]: engineError(409, "CONFLICT", "Checking the downloaded data"),
    });
    renderWatch();

    expect(await screen.findByText("Checking downloaded data…")).toBeVisible();
    expect(screen.getByTestId("player")).toBeInTheDocument();
  });

  it("shows a plain sentence, not a system error, when the torrent failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    watchEngine({
      [TORRENT]: {
        torrent: torrentDetail({
          status: "error",
          error: "ENOSPC: no space left on device, write",
        }),
      },
    });
    renderWatch();

    expect(
      await screen.findByRole("heading", {
        name: "This torrent stopped working",
      }),
    ).toBeVisible();
    expect(screen.getByText("Something went wrong with it.")).toBeVisible();
    expect(screen.queryByText(/ENOSPC/)).toBeNull();
  });

  it("shows the engine's own sentence when the torrent failed", async () => {
    watchEngine({
      [TORRENT]: {
        torrent: torrentDetail({
          status: "error",
          error: "The disk is full. Free some space, then open it again.",
        }),
      },
    });
    renderWatch();

    expect(
      await screen.findByText(
        "The disk is full. Free some space, then open it again.",
      ),
    ).toBeVisible();
  });

  it("prepares the video while its info is read", async () => {
    watchEngine({ [MEDIA]: () => new Promise<Response>(() => undefined) });
    renderWatch();

    expect(await screen.findByText("Preparing video…")).toBeVisible();
    expect(document.title).toBe("Sintel.mp4 · Streamy");
  });

  it("says when the file has no video", async () => {
    watchEngine({ [MEDIA]: apiError(400, "This file has no video") });
    renderWatch();

    expect(
      await screen.findByRole("heading", { name: "This file has no video" }),
    ).toBeVisible();
  });

  it("explains a file that needs converting when ffmpeg isn't working", async () => {
    watchEngine({
      [TORRENT]: {
        torrent: torrentDetail({ files: [torrentFile(0, "Sintel.mkv")] }),
      },
      [MEDIA]: apiError(503, "ffmpeg is missing or can't run"),
    });
    renderWatch();

    expect(
      await screen.findByRole("heading", {
        name: "This video needs converting",
      }),
    ).toBeVisible();
  });

  it("plays an MP4 as it is when ffmpeg isn't working", async () => {
    const engine = watchEngine({
      [MEDIA]: apiError(503, "ffmpeg is missing or can't run"),
    });
    renderWatch();

    await waitFor(() => {
      expect(playerVideo()).toHaveAttribute(
        "src",
        `app://streamy/api/v1/torrents/${HASH}/files/0/stream`,
      );
    });
    expect(engine.callsTo(PLAYBACK)).toHaveLength(0);
  });

  it("offers Try again when reading the info timed out", async () => {
    watchEngine({
      [MEDIA]: apiError(503, "Couldn't read the video info in time."),
    });
    renderWatch();

    expect(
      await screen.findByText("Couldn't read the video info in time."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("says when a torrent can't be opened again", async () => {
    watchEngine({
      [TORRENT]: engineError(404, "NOT_FOUND", "Torrent not found"),
      "POST /v1/torrents": engineError(400, "BAD_REQUEST", "Bad torrent"),
    });
    renderWatch();

    expect(
      await screen.findByRole("heading", {
        name: "Couldn't open this torrent",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("rejects links that don't point to a video", async () => {
    renderWithProviders(<WatchPage />, {
      path: "/watch/:infoHash/:fileIndex",
      route: "/watch/not-a-hash/0",
    });

    expect(
      await screen.findByRole("heading", {
        name: "This link doesn't point to a video",
      }),
    ).toBeVisible();
  });
});

describe("resuming", () => {
  const withProgress = (item: FileProgress) => ({
    [LIBRARY]: { torrent: libraryTorrent(), progress: [item] },
  });

  it("asks before playing, and resumes with Enter", async () => {
    const engine = watchEngine(withProgress(progress()));
    const { user } = renderWatch();

    const resume = await screen.findByRole("button", {
      name: "Resume at 34:12",
    });
    expect(resume).toHaveFocus();
    expect(screen.getByRole("button", { name: "Start over" })).toBeVisible();
    expect(screen.getByText("34:12 of 40:00")).toBeVisible();
    // Nothing plays until the viewer says.
    expect(engine.callsTo(PLAYBACK)).toHaveLength(0);

    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(1);
    });
    // The tracks chosen for this file come back with the position.
    expect(playbackRequests(engine)[0]).toMatchObject({
      start: 2052,
      audioTrack: 1,
      embeddedSubtitles: true,
    });
  });

  it("shows the library's picture of the video behind the question", async () => {
    const thumbnailUrl = `/v1/library/${HASH}/files/0/thumbnail`;
    watchEngine({
      ...withProgress(progress()),
      "GET /v1/library": library({
        continueWatching: [continueItem({ fileIndex: 0, thumbnailUrl })],
      }),
    });
    const { container } = renderWatch();

    await screen.findByRole("button", { name: "Resume at 34:12" });
    await waitFor(() => {
      expect(container.querySelector("img")).toHaveAttribute(
        "src",
        `app://streamy/api${thumbnailUrl}`,
      );
    });
  });

  it("starts over with the preferences instead of the saved tracks", async () => {
    const engine = watchEngine(withProgress(progress()));
    const { user } = renderWatch();

    await user.click(await screen.findByRole("button", { name: "Start over" }));

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(1);
    });
    expect(playbackRequests(engine)[0]).toMatchObject({
      start: 0,
      audioTrack: null,
      embeddedSubtitles: false,
    });
  });

  it("doesn't ask again when the link already said Resume at…", async () => {
    const engine = watchEngine(withProgress(progress()));
    renderWatch({ start: "resume" });

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(1);
    });
    expect(playbackRequests(engine)[0]?.start).toBe(2052);
    expect(screen.queryByRole("button", { name: /Resume at/ })).toBeNull();
  });

  it("starts from the beginning when there's nothing worth resuming", async () => {
    for (const item of [
      progress({ position: 12 }),
      progress({ watched: true }),
    ]) {
      const engine = watchEngine(withProgress(item));
      const view = renderWatch();
      await waitFor(() => {
        expect(playbackRequests(engine)).toHaveLength(1);
      });
      expect(playbackRequests(engine)[0]?.start).toBe(0);
      expect(screen.queryByRole("button", { name: /Resume at/ })).toBeNull();
      view.unmount();
      engine.fetch.mockRestore();
    }
  });

  it("plays from the start quietly while the library doesn't know the file", async () => {
    const engine = watchEngine();
    renderWatch();

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(1);
    });
    expect(playbackRequests(engine)[0]?.start).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves the position once when leaving the player", async () => {
    const { engine, router } = await playing();
    const video = playerVideo();
    video.currentTime = 95;

    await act(() => router.navigate("/"));

    await waitFor(() => {
      expect(engine.callsTo(SAVE)).toHaveLength(1);
    });
    expect(engine.callsTo(SAVE)[0]?.body).toEqual({
      position: 95,
      duration: 888,
      audioTrack: null,
      subtitle: null,
    });
    // keepalive: the request outlives a closing window.
    const init = engine.fetch.mock.calls.find(
      ([, options]) => options?.method === "PUT",
    )?.[1];
    expect(init?.keepalive).toBe(true);
    // The session stops too.
    expect(engine.callsTo("DELETE /v1/playback/p1")).toHaveLength(1);
  });

  it("saves the position when the window closes, and not twice", async () => {
    const { engine, router } = await playing();
    playerVideo().currentTime = 40;

    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await act(() => router.navigate("/"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(engine.callsTo(SAVE)).toHaveLength(1);
    expect(engine.callsTo(SAVE)[0]?.body).toMatchObject({ position: 40 });
  });
});

describe("preferences from Settings", () => {
  it("starts with the audio and subtitle languages from Settings", async () => {
    changeSettings({ audioLanguage: "ja", subtitleLanguage: "fr" });
    const engine = watchEngine();
    renderWatch();

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(1);
    });
    // Japanese audio, French embedded subtitles (so not direct: remux).
    expect(playbackRequests(engine)[0]).toMatchObject({
      audioTrack: 1,
      embeddedSubtitles: true,
    });
  });

  it("remembers the audio and subtitles picked in the player", async () => {
    const { user } = await playing();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("menuitem", { name: /Audio/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Japanese/ }));
    expect(fakeStreamy.api.settings.update).toHaveBeenLastCalledWith({
      audioLanguage: "ja",
    });

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /English/ }));
    expect(fakeStreamy.api.settings.update).toHaveBeenLastCalledWith({
      subtitleLanguage: "en",
    });

    // C turns them off: remembered as "off".
    await user.keyboard("c");
    expect(fakeStreamy.api.settings.update).toHaveBeenLastCalledWith({
      subtitleLanguage: SUBTITLES_OFF,
    });
  });

  it("shows subtitles in the look from Settings, and follows changes live", async () => {
    changeSettings({ subtitleLanguage: "en" });
    await playing();

    const line = await screen.findByText("Hello there");
    expect(line).toHaveClass(
      "[text-shadow:0_0_2px_#000,0_0_2px_#000,0_0_4px_#000,0_1px_3px_#000]",
    );

    changeSettings({
      subtitleLanguage: "en",
      subtitleBackground: "box",
      subtitleColor: "yellow",
    });
    await waitFor(() => {
      expect(screen.getByText("Hello there")).toHaveClass("bg-black/75");
    });
    expect(screen.getByText("Hello there").closest("p")).toHaveClass(
      "text-yellow-300",
    );
  });

  it("changes the subtitle settings from the player's Style panel", async () => {
    const { user } = await playing();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    await user.click(screen.getByRole("menuitem", { name: /Style/ }));
    await user.click(screen.getByRole("radio", { name: "XL" }));

    expect(fakeStreamy.api.settings.update).toHaveBeenLastCalledWith({
      subtitleSize: "xl",
    });
  });

  it("keeps the volume in this window's storage", async () => {
    localStorage.setItem(
      "streamy-player",
      JSON.stringify({ volume: 0.3, muted: false, subtitleDelay: 0 }),
    );
    const { user } = await playing();
    expect(playerVideo().volume).toBe(0.3);

    await user.keyboard("m");

    expect(JSON.parse(localStorage.getItem("streamy-player") ?? "")).toEqual({
      volume: 0.3,
      muted: true,
      subtitleDelay: 0,
    });
  });
});

describe("the desktop", () => {
  it("keeps the screen awake only while the video plays", async () => {
    const { setPlaying } = fakeStreamy.api.player;
    const { router } = await playing();

    await waitFor(() => {
      expect(setPlaying).toHaveBeenLastCalledWith(true);
    });

    act(() => {
      playerVideo().pause();
    });
    expect(setPlaying).toHaveBeenLastCalledWith(false);

    await act(() => playerVideo().play());
    expect(setPlaying).toHaveBeenLastCalledWith(true);

    // Leaving the player always lets the screen sleep again.
    await act(() => router.navigate("/"));
    expect(setPlaying).toHaveBeenLastCalledWith(false);
    const calls = setPlaying.mock.calls.map(([value]) => value);
    expect(calls.filter(Boolean)).toHaveLength(
      calls.filter((value) => !value).length,
    );
  });

  it("lets the screen sleep when the video ends or fails", async () => {
    const { setPlaying } = fakeStreamy.api.player;
    await playing();
    await waitFor(() => {
      expect(setPlaying).toHaveBeenLastCalledWith(true);
    });

    act(() => {
      Object.defineProperty(playerVideo(), "ended", { value: true });
      fireEvent(playerVideo(), new Event("ended"));
    });

    expect(setPlaying).toHaveBeenLastCalledWith(false);
  });

  it("goes full screen with F, the button and a double-click", async () => {
    const uninstall = installFullscreen();
    try {
      const { user } = await playing();
      const player = screen.getByTestId("player");

      await user.keyboard("f");
      expect(document.fullscreenElement).toBe(player);
      expect(
        screen.getByRole("button", { name: "Exit full screen" }),
      ).toBeVisible();
      // The title bar is gone in full screen: the player has its own Back.
      expect(screen.getByRole("button", { name: "Back" })).toBeVisible();

      await user.keyboard("{Escape}");
      expect(document.fullscreenElement).toBeNull();

      await user.click(screen.getByRole("button", { name: "Full screen" }));
      expect(document.fullscreenElement).toBe(player);
      await user.click(
        screen.getByRole("button", { name: "Exit full screen" }),
      );
      expect(document.fullscreenElement).toBeNull();

      fireEvent.doubleClick(player.querySelector("video + div") as Element);
      expect(document.fullscreenElement).toBe(player);
    } finally {
      uninstall();
    }
  });

  it("leaves the window's own full screen with the button, F and a double-click", async () => {
    const uninstall = installFullscreen();
    try {
      const { user } = await playing();
      const { setFullScreen } = fakeStreamy.api.window;
      const enterFromMenu = () => {
        // View → Enter Full Screen, F11, ⌃⌘F…
        act(() => {
          fakeStreamy.setFullScreen(true);
        });
      };

      enterFromMenu();
      // The title bar is gone: the player has its own Back.
      expect(screen.getByRole("button", { name: "Back" })).toBeVisible();
      await user.click(
        screen.getByRole("button", { name: "Exit full screen" }),
      );
      expect(setFullScreen).toHaveBeenLastCalledWith(false);
      // Not HTML full screen on top of it.
      expect(document.fullscreenElement).toBeNull();
      expect(screen.getByRole("button", { name: "Full screen" })).toBeVisible();

      enterFromMenu();
      await user.keyboard("f");
      expect(setFullScreen).toHaveBeenCalledTimes(2);

      enterFromMenu();
      const picture = screen.getByTestId("player").querySelector("video + div");
      fireEvent.doubleClick(picture as Element);
      expect(setFullScreen).toHaveBeenCalledTimes(3);
      expect(document.fullscreenElement).toBeNull();
    } finally {
      uninstall();
    }
  });

  it("shows the controls when Tab reaches them, and keeps them while focused", async () => {
    const { user } = await playing();
    const player = screen.getByTestId("player");
    // The mouse left the window while playing: the controls went.
    await user.hover(player);
    await user.unhover(player);
    expect(player).toHaveClass("cursor-none");

    await user.tab();

    expect(screen.getByRole("slider", { name: "Seek" })).toHaveFocus();
    expect(player).not.toHaveClass("cursor-none");
    await user.unhover(player);
    expect(player).not.toHaveClass("cursor-none");
  });

  it("doesn't keep the controls for a button clicked with the mouse", async () => {
    const { user } = await playing();
    const player = screen.getByTestId("player");

    await user.click(screen.getByRole("button", { name: "Back 10 seconds" }));
    await user.unhover(player);

    expect(player).toHaveClass("cursor-none");
  });

  it("ignores its keys with ⌘ held, and while a dialog is open", async () => {
    const uninstall = installFullscreen();
    try {
      const { user } = await playing();

      await user.keyboard("{Meta>}f{/Meta}");
      expect(document.fullscreenElement).toBeNull();

      const dialog = document.createElement("dialog");
      dialog.setAttribute("open", "");
      document.body.append(dialog);
      await user.keyboard("f");
      expect(document.fullscreenElement).toBeNull();
      dialog.remove();
    } finally {
      uninstall();
    }
  });
});

describe("media keys and Now Playing", () => {
  let media: ReturnType<typeof installMediaSession>;
  beforeEach(() => {
    media = installMediaSession();
  });
  afterEach(() => {
    media.uninstall();
  });

  const twoEpisodes = (): TorrentDetail =>
    torrentDetail({
      name: "The Show",
      files: [
        torrentFile(0, "Episode 1.mp4"),
        torrentFile(3, "Episode 2.mp4"),
        torrentFile(1, "Sintel.en.srt", "subtitle"),
      ],
    });

  it("names the video and the torrent, with the library's picture", async () => {
    const thumbnailUrl = `/v1/library/${HASH}/files/0/thumbnail`;
    // Now Playing only takes http(s), data: and blob: pictures.
    URL.createObjectURL = vi.fn(() => "blob:app://streamy/thumbnail");
    URL.revokeObjectURL = vi.fn();
    await playing({
      [TORRENT]: { torrent: twoEpisodes() },
      "GET /v1/library": library({
        continueWatching: [continueItem({ fileIndex: 0, thumbnailUrl })],
      }),
      [`GET ${thumbnailUrl}`]: () =>
        new Response(new Blob(["jpeg"], { type: "image/jpeg" })),
    });
    const session: FakeMediaSession = media.session;

    await waitFor(() => {
      expect(session.metadata).toMatchObject({
        title: "Episode 1",
        artist: "The Show",
        artwork: [{ src: "blob:app://streamy/thumbnail" }],
      });
    });
    await waitFor(() => {
      expect(session.playbackState).toBe("playing");
    });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 888,
      playbackRate: 1,
      position: 0,
    });
  });

  it("plays, pauses and seeks on the movie's timeline", async () => {
    await playing();
    const { session } = media;
    await waitFor(() => {
      expect(session.playbackState).toBe("playing");
    });

    session.press("pause");
    expect(playerVideo().paused).toBe(true);
    session.press("play");
    expect(playerVideo().paused).toBe(false);

    session.press("seekto", { seekTime: 300 });
    expect(playerVideo().currentTime).toBe(300);
    session.press("seekforward", {});
    expect(playerVideo().currentTime).toBe(310);
    session.press("seekbackward", { seekOffset: 30 });
    expect(playerVideo().currentTime).toBe(280);
    session.press("stop");
    expect(playerVideo().paused).toBe(true);
  });

  it("goes to the next video in the torrent, and only offers what exists", async () => {
    const { router } = await playing({
      [TORRENT]: { torrent: twoEpisodes() },
      // The next episode's player (only where it went matters here).
      [`GET /v1/torrents/${HASH}/files/3/media`]: () =>
        new Promise<Response>(() => undefined),
    });
    const { session } = media;

    await waitFor(() => {
      expect(session.handlers.has("nexttrack")).toBe(true);
    });
    expect(session.handlers.has("previoustrack")).toBe(false);

    session.press("nexttrack");
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/watch/${HASH}/3`);
    });
  });

  it("lets go of everything when the player closes", async () => {
    const { router } = await playing();
    const { session } = media;
    await waitFor(() => {
      expect(session.handlers.size).toBeGreaterThan(0);
    });

    await act(() => router.navigate("/"));

    expect(session.handlers.size).toBe(0);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });
});

describe("the player and the engine", () => {
  it("names this player in every start, and stops it when leaving", async () => {
    const { engine, router } = await playing();
    expect(playbackRequests(engine)[0]?.playerId).toBe(PLAYER_ID);

    await act(() => router.navigate("/"));

    // Also stops a start still in progress (a fetch abort doesn't reach it).
    expect(engine.callsTo(STOP_PLAYER)).toHaveLength(1);
    // keepalive: the request outlives a closing window.
    const init = engine.fetch.mock.calls.find(
      ([url]) => url === `app://streamy/api/v1/players/${PLAYER_ID}`,
    )?.[1];
    expect(init?.keepalive).toBe(true);
  });

  it("writes names right to left when they are", async () => {
    await playing({
      [TORRENT]: {
        torrent: torrentDetail({
          name: "סדרה",
          files: [torrentFile(0, "פרק 1.mp4")],
        }),
      },
    });

    expect(screen.getByRole("heading", { name: "פרק 1" })).toHaveAttribute(
      "dir",
      "auto",
    );
    expect(screen.getByText("סדרה")).toHaveAttribute("dir", "auto");
  });
});

describe("engine restarts", () => {
  it("says it's reconnecting, then carries on where it was", async () => {
    const { engine } = await playing();
    playerVideo().currentTime = 120;

    act(() => {
      fakeStreamy.setEngineStatus({ state: "restarting", error: null });
    });
    expect(await screen.findByText("Reconnecting…")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(playerVideo().paused).toBe(true);

    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(2);
    });
    // The old session died with the engine: nothing to replace.
    expect(playbackRequests(engine)[1]).toMatchObject({
      start: 120,
      replaces: null,
    });
    await waitFor(() => {
      expect(screen.queryByText("Reconnecting…")).toBeNull();
    });
  });

  it("opens the torrent again when the restarted engine has forgotten it", async () => {
    let starts = 0;
    const { engine } = await playing({
      [PLAYBACK]: () => {
        starts += 1;
        return starts === 2
          ? engineError(404, "NOT_FOUND", "Torrent not found")
          : { playback: directPlayback({ id: `p${starts}` }) };
      },
      [TORRENT]: () =>
        starts >= 2
          ? engineError(404, "NOT_FOUND", "Torrent not found")
          : { torrent: torrentDetail() },
      "POST /v1/torrents": { torrent: torrentDetail() },
      "DELETE /v1/playback/p3": noContent(),
    });

    act(() => {
      fakeStreamy.setEngineStatus({ state: "restarting", error: null });
    });
    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });

    await waitFor(() => {
      expect(playbackRequests(engine)).toHaveLength(3);
    });
    expect(engine.callsTo("POST /v1/torrents")[0]?.body).toEqual({
      magnet: HASH,
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

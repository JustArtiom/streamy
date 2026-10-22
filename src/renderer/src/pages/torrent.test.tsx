import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileProgress } from "../../../shared/engine-api";
import {
  type EngineAnswer,
  engineError,
  mockEngine,
  noContent,
} from "@/test/engine";
import { fakeStreamy } from "@/test/fake-streamy";
import {
  HASH,
  library,
  libraryTorrent,
  torrentDetail,
  torrentFile,
} from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { wholeText } from "@/test/text";

const TORRENT = `GET /v1/torrents/${HASH}`;
const LIBRARY = `GET /v1/library/${HASH}`;
const notFound = engineError(404, "NOT_FOUND", "Torrent not found");

afterEach(() => {
  vi.useRealTimers();
});

function progress(overrides: Partial<FileProgress> = {}): FileProgress {
  return {
    infoHash: HASH,
    fileIndex: 0,
    fileName: "Sintel.mp4",
    position: 2052,
    duration: 2_400,
    audioTrack: null,
    subtitle: null,
    watched: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderPage(
  routes: Record<string, EngineAnswer>,
  state?: { justAdded?: boolean },
) {
  const engine = mockEngine({ "GET /v1/library": library(), ...routes });
  const view = renderApp({ route: { pathname: `/torrent/${HASH}`, state } });
  return { ...view, engine };
}

describe("the torrent page", () => {
  it("lists the files by kind, with a Play button for videos", async () => {
    renderPage({ [TORRENT]: { torrent: torrentDetail() } });

    expect(
      await screen.findByRole("heading", { name: "Sintel" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Play Sintel.mp4" }),
    ).toHaveAttribute("href", `/watch/${HASH}/0`);
    expect(screen.getByText("Sintel.en.srt")).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.getByText("3 peers")).toBeVisible();
    expect(document.title).toBe("Sintel · Streamy");
  });

  it("puts videos first, in natural order", async () => {
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          files: [
            torrentFile(0, "readme.txt", "other"),
            torrentFile(1, "Episode 10.mkv"),
            torrentFile(2, "Episode 2.mkv"),
          ],
        }),
      },
    });

    const links = await screen.findAllByRole("link", { name: /^Play / });
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Play Episode 2.mkv",
      "Play Episode 10.mkv",
    ]);
    expect(screen.getByText("Other files")).toBeVisible();
  });

  it("offers to resume where you left off, and says what's watched", async () => {
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          files: [torrentFile(0, "E01.mkv"), torrentFile(1, "E02.mkv")],
        }),
      },
      [LIBRARY]: {
        torrent: libraryTorrent(),
        progress: [
          progress({ fileIndex: 0, fileName: "E01.mkv", watched: true }),
          progress({ fileIndex: 1, fileName: "E02.mkv", position: 2052 }),
        ],
      },
    });

    const resume = await screen.findByRole("link", {
      name: "Resume E02.mkv at 34:12",
    });
    expect(resume).toHaveTextContent("Resume at 34:12");
    expect(resume).toHaveAttribute("href", `/watch/${HASH}/1`);
    expect(screen.getByRole("link", { name: "Play E01.mkv" })).toBeVisible();
    expect(screen.getByText("Watched")).toBeVisible();
  });

  it("goes straight to the player when just added with one video", async () => {
    const { router } = renderPage(
      {
        [TORRENT]: { torrent: torrentDetail() },
        // The player stays on "loading": this test is about getting there.
        [`GET /v1/torrents/${HASH}/files/0/media`]: () => new Promise(() => {}),
      },
      { justAdded: true },
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/watch/${HASH}/0`);
    });
  });

  it("stays on the page with several videos", async () => {
    const { router } = renderPage(
      {
        [TORRENT]: {
          torrent: torrentDetail({
            files: [torrentFile(0, "E01.mkv"), torrentFile(1, "E02.mkv")],
          }),
        },
      },
      { justAdded: true },
    );

    expect(await screen.findByText("E02.mkv")).toBeVisible();
    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });

  it("hints that nobody shares it after 30 s without metadata", async () => {
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          name: null,
          status: "fetching_metadata",
          size: null,
          files: [],
          peers: 0,
          addedAt: new Date(Date.now() - 45_000).toISOString(),
        }),
      },
    });

    expect(
      await screen.findByText("Finding peers and the file list…"),
    ).toBeVisible();
    expect(screen.getByText("Finding peers")).toBeVisible();
    expect(screen.getByText("Nobody seems to be sharing this")).toBeVisible();
  });

  it("says it's checking the data on disk, not looking for peers", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { engine } = renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          status: "checking",
          peers: 0,
          // Long enough ago for the "nobody's sharing" hint, if it showed.
          addedAt: new Date(Date.now() - 45_000).toISOString(),
        }),
      },
    });

    expect(await screen.findByText("Checking downloaded data…")).toBeVisible();
    expect(screen.getByText("Checking")).toBeVisible();
    expect(screen.queryByText(/Finding peers/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nobody seems to be sharing this"),
    ).not.toBeInTheDocument();
    // Nothing to play until it's done.
    expect(
      screen.queryByRole("link", { name: /^Play / }),
    ).not.toBeInTheDocument();

    // Asked often, so Play shows up as soon as it's done.
    engine.on(TORRENT, { torrent: torrentDetail() });
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(
      await screen.findByRole("link", { name: "Play Sintel.mp4" }),
    ).toBeVisible();
  });

  it("shows a torrent that stopped working", async () => {
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({ status: "error", error: "Disk is full" }),
      },
    });

    expect(
      await screen.findByText("This torrent stopped working"),
    ).toBeVisible();
    expect(screen.getByText("Disk is full")).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove it" })).toBeVisible();
  });

  it("never shows a system error as the reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          status: "error",
          error: "ENOSPC: no space left on device, write '/Users/ann/x.mkv'",
        }),
      },
    });

    expect(
      await screen.findByText("This torrent stopped working"),
    ).toBeVisible();
    expect(screen.getByText("Something went wrong with it.")).toBeVisible();
    expect(screen.queryByText(/ENOSPC/)).not.toBeInTheDocument();
  });

  it("writes right-to-left names from their own side", async () => {
    const name = "סרט הבית";
    renderPage({
      [TORRENT]: {
        torrent: torrentDetail({
          name,
          files: [torrentFile(0, `${name}.mkv`)],
        }),
      },
    });

    const heading = await screen.findByRole("heading", { name });
    expect(heading).toHaveAttribute("dir", "auto");
    // Cut at its own end when it's too long for the row.
    expect(screen.getByText(`${name}.mkv`)).toHaveAttribute("dir", "auto");
  });

  // Minimizing Streamy to let it download is normal. If the polls stopped,
  // the engine would stop the torrent after the "keep sharing" time.
  it("keeps asking for it while the window is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { engine } = renderPage({ [TORRENT]: { torrent: torrentDetail() } });
    await screen.findByRole("heading", { name: "Sintel" });

    act(() => {
      focusManager.setFocused(false);
    });
    try {
      const before = engine.callsTo(TORRENT).length;
      await act(() => vi.advanceTimersByTimeAsync(3 * 5_000));
      expect(engine.callsTo(TORRENT).length).toBeGreaterThanOrEqual(before + 3);
    } finally {
      act(() => {
        focusManager.setFocused(undefined);
      });
    }
  });

  it("says the link is wrong for something that isn't an info hash", () => {
    mockEngine();
    renderApp({ route: "/torrent/not-a-hash" });

    expect(
      screen.getByRole("heading", {
        name: "This link doesn't point to a torrent",
      }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("waits for the engine while it restarts", async () => {
    act(() => {
      fakeStreamy.setEngineStatus({ state: "restarting", error: null });
    });
    renderPage({ [TORRENT]: { torrent: torrentDetail() } });

    expect(
      await screen.findByRole("heading", {
        name: "Waiting for the playback engine…",
      }),
    ).toBeVisible();

    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });
    expect(
      await screen.findByRole("heading", { name: "Sintel" }),
    ).toBeVisible();
  });
});

describe("opening a torrent that isn't active anymore", () => {
  it("opens it again (from the library) on a 404", async () => {
    const { engine } = renderPage({
      [TORRENT]: notFound,
      "POST /v1/torrents": () => {
        engine.on(TORRENT, { torrent: torrentDetail() });
        return { torrent: torrentDetail() };
      },
    });

    expect(
      await screen.findByRole("heading", { name: "Sintel" }),
    ).toBeVisible();
    expect(engine.callsTo("POST /v1/torrents")).toEqual([
      { method: "POST", path: "/v1/torrents", body: { magnet: HASH } },
    ]);
  });

  it("explains when that fails, once, with a way back", async () => {
    const { engine, user } = renderPage({
      [TORRENT]: notFound,
      [LIBRARY]: { torrent: libraryTorrent(), progress: [] },
      "POST /v1/torrents": engineError(
        409,
        "CONFLICT",
        "This torrent's saved file list is damaged.",
      ),
    });

    expect(
      await screen.findByRole("heading", { name: "Couldn't open Sintel" }),
    ).toBeVisible();
    expect(
      screen.getByText("This torrent's saved file list is damaged."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(engine.callsTo("POST /v1/torrents")).toHaveLength(1);

    engine.on("POST /v1/torrents", { torrent: torrentDetail() });
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { name: "Sintel" }),
    ).toBeVisible();
  });
});

describe("opening it again while the engine is busy (503)", () => {
  const busy = engineError(
    503,
    "SERVICE_UNAVAILABLE",
    "Streamy is deleting its videos. Try again in a moment.",
  );

  // Settings → "Clear now" stops every torrent and deletes the videos. The
  // page's next poll gets a 404, and opening it again gets a 503 until the
  // deleting is done.
  it("keeps trying for a bit, then carries on", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let busyAnswers = 2;
    const { engine } = renderPage({
      [TORRENT]: { torrent: torrentDetail() },
      "POST /v1/torrents": () => {
        if (busyAnswers > 0) {
          busyAnswers -= 1;
          return busy;
        }
        engine.on(TORRENT, { torrent: torrentDetail() });
        return { torrent: torrentDetail() };
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Sintel" }),
    ).toBeVisible();

    engine.on(TORRENT, notFound); // cleared
    await act(() => vi.advanceTimersByTimeAsync(5_000 + 1_000 + 2_000));

    await waitFor(() => {
      expect(engine.callsTo("POST /v1/torrents")).toHaveLength(3);
    });
    expect(screen.getByRole("heading", { name: "Sintel" })).toBeVisible();
    expect(
      screen.queryByText("Couldn't refresh this torrent"),
    ).not.toBeInTheDocument();

    // And it goes on polling (it isn't stuck).
    const polls = engine.callsTo(`GET /v1/torrents/${HASH}`).length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(engine.callsTo(`GET /v1/torrents/${HASH}`).length).toBeGreaterThan(
      polls,
    );
  });

  it("says it couldn't open it once it has tried a few times", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { engine } = renderPage({
      [TORRENT]: notFound,
      [LIBRARY]: { torrent: libraryTorrent(), progress: [] },
      "POST /v1/torrents": busy,
    });

    await act(() => vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000));
    expect(
      screen.queryByRole("heading", { name: "Couldn't open Sintel" }),
    ).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(8_000));
    expect(
      await screen.findByRole("heading", { name: "Couldn't open Sintel" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Streamy is deleting its videos. Try again in a moment.",
      ),
    ).toBeVisible();
    // The first try and four more.
    expect(engine.callsTo("POST /v1/torrents")).toHaveLength(5);
  });
});

describe("removing", () => {
  function setup() {
    const view = renderPage({
      [TORRENT]: { torrent: torrentDetail() },
      [`DELETE /v1/torrents/${HASH}`]: noContent,
    });
    return view;
  }

  it("deletes the downloaded video but keeps it in Recent", async () => {
    const { engine, router, user } = setup();

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Sintel?" });
    expect(
      within(dialog).getByRole("radio", {
        name: /Delete the downloaded video/,
      }),
    ).toBeChecked();
    await user.click(
      within(dialog).getByRole("button", { name: "Delete video" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(engine.callsTo(`DELETE /v1/torrents/${HASH}`)).toEqual([
      { method: "DELETE", path: `/v1/torrents/${HASH}`, body: null },
    ]);
    expect(
      await screen.findByText(
        wholeText("Deleted the downloaded video of Sintel"),
      ),
    ).toBeVisible();
    // The page that removed it never opened it again.
    expect(engine.callsTo("POST /v1/torrents")).toHaveLength(0);
  });

  it("can remove it from Streamy completely", async () => {
    const { engine, router, user } = setup();

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    await user.click(
      screen.getByRole("radio", { name: /Remove it from Streamy/ }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(engine.calls.filter((call) => call.method === "DELETE")).toEqual([
      {
        method: "DELETE",
        path: `/v1/torrents/${HASH}?forget=true`,
        body: null,
      },
    ]);
    expect(
      await screen.findByText(wholeText("Removed Sintel from Streamy")),
    ).toBeVisible();
  });

  it("stays open with the reason when it fails", async () => {
    const { engine, router, user } = setup();
    engine.on(
      `DELETE /v1/torrents/${HASH}`,
      engineError(500, "INTERNAL", "Couldn't delete the files"),
    );

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    await user.click(screen.getByRole("button", { name: "Delete video" }));

    // What went wrong inside the engine stays in the console.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The playback engine ran into a problem. Please try again.",
    );
    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });

  it("stays open while it removes, so what follows isn't lost", async () => {
    const { engine, router, user } = setup();
    let finish: () => void = () => undefined;
    engine.on(
      `DELETE /v1/torrents/${HASH}`,
      () =>
        new Promise<Response>((resolve) => {
          finish = () => {
            resolve(noContent());
          };
        }),
    );

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Sintel?" });
    await user.click(screen.getByRole("button", { name: "Delete video" }));
    await waitFor(() => {
      expect(engine.callsTo(`DELETE /v1/torrents/${HASH}`)).toHaveLength(1);
    });

    // Esc asks to close ("cancel"): the answer is no.
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(
      false,
    );
    // A click on the backdrop (the <dialog> itself) does nothing.
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    expect(dialog).toHaveAttribute("open");
    // A second Esc in a row closes it whatever the page says: it comes back.
    act(() => {
      (dialog as HTMLDialogElement).close();
    });
    expect(dialog).toHaveAttribute("open");

    act(() => {
      finish();
    });

    // The toast and going Home still happen.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(
      await screen.findByText(
        wholeText("Deleted the downloaded video of Sintel"),
      ),
    ).toBeVisible();
  });

  it("closes with Esc or a click outside when nothing runs", async () => {
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Sintel?" });
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(
      true,
    );
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);

    expect(dialog).not.toHaveAttribute("open");
  });

  it("goes back to the choice it started with after Cancel", async () => {
    const { user } = setup();

    await user.click(await screen.findByRole("button", { name: "Remove…" }));
    await user.click(
      screen.getByRole("radio", { name: /Remove it from Streamy/ }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Remove…" }));

    expect(
      screen.getByRole("radio", { name: /Delete the downloaded video/ }),
    ).toBeChecked();
  });
});

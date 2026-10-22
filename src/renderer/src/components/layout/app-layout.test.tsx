import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeSettings } from "@/lib/settings";
import { engineError, mockEngine } from "@/test/engine";
import { fakeStreamy } from "@/test/fake-streamy";
import { HASH, library, torrentDetail } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { wholeText } from "@/test/text";

const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;

/** An engine with an empty library and the Sintel torrent. */
function sintelEngine() {
  const engine = mockEngine({
    "GET /v1/library": library(),
    [`GET /v1/torrents/${HASH}`]: {
      torrent: torrentDetail({ files: [] }),
    },
    "POST /v1/torrents": { torrent: torrentDetail({ files: [] }) },
    "POST /v1/torrents/file": { torrent: torrentDetail({ files: [] }) },
    // The player stays on "loading": these tests are about the layout.
    [`GET /v1/torrents/${HASH}/files/0/media`]: () => new Promise(() => {}),
  });
  return engine;
}

describe("the title bar's Back button", () => {
  it("is always there, greyed out on Home with nothing before it", () => {
    sintelEngine();
    renderApp();

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("sits left, with the logo in the middle and Settings right", () => {
    sintelEngine();
    renderApp();

    const bar = screen.getByRole("banner");
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Back", "Forward", "Settings"]);
    // The logo doesn't catch clicks: the bar under it drags the window.
    expect(within(bar).getByText("Streamy").parentElement).toHaveClass(
      "pointer-events-none",
      "justify-center",
    );
  });

  it("goes back like a browser", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("POP");
  });

  it("goes Home when the window opened on this page", async () => {
    sintelEngine();
    const { router, user } = renderApp({ route: `/torrent/${HASH}` });

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("works with ⌘[ too", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));

    // "[[" is a literal "[" for user-event.
    await user.keyboard("{Meta>}[[{/Meta}");

    expect(router.state.location.pathname).toBe("/");
  });

  it("doesn't let the window be dragged from it", () => {
    sintelEngine();
    renderApp({ route: `/torrent/${HASH}` });

    expect(screen.getByRole("button", { name: "Back" })).toHaveClass(
      "no-drag-region",
    );
    expect(screen.getByRole("button", { name: "Forward" })).toHaveClass(
      "no-drag-region",
    );
  });
});

describe("the title bar's Forward button", () => {
  it("goes forward again after going back", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));
    const forward = screen.getByRole("button", { name: "Forward" });
    expect(forward).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/");
    await waitFor(() => {
      expect(forward).toBeEnabled();
    });

    await user.click(forward);
    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    await waitFor(() => {
      expect(forward).toBeDisabled();
    });
  });

  it("forgets the way forward once you go somewhere new", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled();
    });

    await act(() => router.navigate("/somewhere-else"));

    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("works with ⌘] too", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));
    await user.keyboard("{Meta>}[[{/Meta}");
    expect(router.state.location.pathname).toBe("/");

    await user.keyboard("{Meta>}]{/Meta}");

    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });
});

describe("the mouse's back button", () => {
  it("goes back from anywhere", async () => {
    sintelEngine();
    const { router } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));

    fireEvent.mouseUp(screen.getByRole("main"), { button: 3 });

    expect(router.state.location.pathname).toBe("/");
    expect(router.state.historyAction).toBe("POP");
  });

  it("leaves the other buttons alone", async () => {
    sintelEngine();
    const { router } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));

    fireEvent.mouseUp(screen.getByRole("main"), { button: 0 });
    fireEvent.mouseUp(screen.getByRole("main"), { button: 1 });
    fireEvent.mouseUp(screen.getByRole("main"), { button: 2 });

    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });

  it("goes forward with the mouse's forward button", async () => {
    sintelEngine();
    const { router } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));
    fireEvent.mouseUp(screen.getByRole("main"), { button: 3 });
    expect(router.state.location.pathname).toBe("/");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled();
    });

    fireEvent.mouseUp(screen.getByRole("main"), { button: 4 });

    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });

  it("doesn't change the page behind a dialog", async () => {
    sintelEngine();
    const { router } = renderApp();
    await act(() => router.navigate(`/torrent/${HASH}`));
    act(() => {
      fakeStreamy.openFromMenu(); // Settings
    });

    try {
      fireEvent.mouseUp(document.body, { button: 3 });
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    } finally {
      // The dialog's state is app-wide: don't leave it open for other tests.
      act(() => {
        closeSettings();
      });
    }
  });
});

describe("the window in full screen", () => {
  it("gives the player the whole screen: no title bar", async () => {
    sintelEngine();
    renderApp({ route: `/watch/${HASH}/0` });
    expect(await screen.findByRole("banner")).toBeVisible();

    act(() => {
      fakeStreamy.setFullScreen(true);
    });
    expect(screen.queryByRole("banner")).not.toBeInTheDocument();

    act(() => {
      fakeStreamy.setFullScreen(false);
    });
    expect(screen.getByRole("banner")).toBeVisible();
  });

  it("brings the title bar back when leaving the player", async () => {
    sintelEngine();
    const { router } = renderApp({ route: `/watch/${HASH}/0` });
    await screen.findByRole("banner");
    act(() => {
      fakeStreamy.setFullScreen(true);
    });

    await act(() => router.navigate("/"));

    expect(screen.getByRole("banner")).toBeVisible();
  });

  it("keeps the title bar on other pages", () => {
    sintelEngine();
    renderApp();

    act(() => {
      fakeStreamy.setFullScreen(true);
    });

    expect(screen.getByRole("banner")).toBeVisible();
  });

  it("keeps ⌘[ working while the title bar is hidden", async () => {
    sintelEngine();
    const { router, user } = renderApp();
    await act(() => router.navigate(`/watch/${HASH}/0`));
    await screen.findByRole("banner");
    act(() => {
      fakeStreamy.setFullScreen(true);
    });

    await user.keyboard("{Meta>}[[{/Meta}");

    expect(router.state.location.pathname).toBe("/");
  });
});

describe("pages", () => {
  it("treats /index.html as Home", async () => {
    sintelEngine();
    const { router } = renderApp({ route: "/index.html" });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/");
    });
    expect(
      screen.getByRole("heading", { name: "What do you want to watch?" }),
    ).toBeVisible();
  });

  it("says when a page doesn't exist", () => {
    sintelEngine();
    renderApp({ route: "/nope" });

    expect(screen.getByRole("heading", { name: "Nothing here" })).toBeVisible();
  });

  it("lets the player fill the window under the title bar", () => {
    sintelEngine();
    renderApp({ route: `/watch/${HASH}/0` });

    const main = screen.getByRole("main");
    expect(main).toHaveClass("overflow-hidden");
    expect(main).not.toHaveClass("overflow-y-auto");
    expect(screen.getByRole("banner")).toBeVisible(); // the title bar
  });

  it("scrolls normal pages", () => {
    sintelEngine();
    renderApp();

    expect(screen.getByRole("main")).toHaveClass("overflow-y-auto");
  });
});

describe("dropping a .torrent on the window", () => {
  function drag(
    type: "dragEnter" | "dragOver" | "dragLeave" | "drop",
    files: File[],
  ) {
    fireEvent[type](window, {
      dataTransfer: { types: ["Files"], files, dropEffect: "none" },
    });
  }

  it("shows where to drop it, then opens it", async () => {
    const engine = sintelEngine();
    const { router } = renderApp();
    const file = new File(["d8:announce"], "Sintel.torrent");

    drag("dragEnter", [file]);
    expect(screen.getByText("Drop the .torrent to open it")).toBeVisible();

    drag("drop", [file]);
    expect(
      screen.queryByText("Drop the .torrent to open it"),
    ).not.toBeInTheDocument();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(engine.callsTo("POST /v1/torrents/file")[0]?.body).toBe(file);
  });

  it("stops the browser from opening the file", () => {
    sintelEngine();
    renderApp();

    const over = fireEvent.dragOver(window, {
      dataTransfer: { types: ["Files"], files: [], dropEffect: "none" },
    });
    const drop = fireEvent.drop(window, {
      dataTransfer: { types: ["Files"], files: [], dropEffect: "none" },
    });

    // fireEvent returns false when the event was cancelled.
    expect(over).toBe(false);
    expect(drop).toBe(false);
  });

  it("hides the overlay when the drag leaves the window", () => {
    sintelEngine();
    renderApp();
    const file = new File([""], "Sintel.torrent");

    drag("dragEnter", [file]);
    drag("dragEnter", [file]); // a child element
    drag("dragLeave", [file]);
    expect(screen.getByTestId("drop-overlay")).toBeVisible();
    drag("dragLeave", [file]);

    expect(screen.queryByTestId("drop-overlay")).not.toBeInTheDocument();
  });

  it("says why it won't open something else", async () => {
    const engine = sintelEngine();
    renderApp();

    drag("drop", [new File([""], "movie.mkv")]);

    expect(
      await screen.findByText(wholeText(`"movie.mkv" isn't a .torrent file`)),
    ).toBeVisible();
    expect(engine.callsTo("POST /v1/torrents/file")).toHaveLength(0);
  });

  it("works on any page", async () => {
    sintelEngine();
    const { router } = renderApp({ route: "/nope" });

    drag("drop", [new File([""], "Sintel.torrent")]);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
  });
});

describe("links from outside Streamy", () => {
  it("opens a clicked magnet link's page", async () => {
    const engine = sintelEngine();
    const { router } = renderApp({ route: "/nope" });

    act(() => {
      fakeStreamy.openMagnetLink(MAGNET);
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(engine.callsTo("POST /v1/torrents")[0]?.body).toEqual({
      magnet: MAGNET,
    });
  });

  it("keeps a link that arrived before the window was ready", async () => {
    sintelEngine();
    fakeStreamy.openMagnetLink(MAGNET); // e.g. the link that launched Streamy

    const { router } = renderApp();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
  });

  it("waits for the engine when it's still starting", async () => {
    const engine = sintelEngine();
    act(() => {
      fakeStreamy.setEngineStatus({ state: "starting", error: null });
    });
    const { router } = renderApp();

    act(() => {
      fakeStreamy.openMagnetLink(MAGNET);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(engine.callsTo("POST /v1/torrents")).toHaveLength(0);

    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
  });

  it("says why a magnet link couldn't be opened", async () => {
    mockEngine({
      "GET /v1/library": library(),
      "POST /v1/torrents": engineError(
        400,
        "VALIDATION_FAILED",
        "Invalid magnet link",
      ),
    });
    const { router } = renderApp();

    act(() => {
      fakeStreamy.openMagnetLink("magnet:?xt=urn:btih:nope");
    });

    expect(
      await screen.findByText("Couldn't open the magnet link"),
    ).toBeVisible();
    expect(screen.getByText("Invalid magnet link")).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });

  it("opens a .torrent file the main process already added", async () => {
    sintelEngine();
    const { router } = renderApp();

    act(() => {
      fakeStreamy.openTorrentFile({ status: "ok", infoHash: HASH });
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(
      await screen.findByText(
        "Peers can see your IP address while a torrent is active.",
      ),
    ).toBeVisible();
  });

  it("says why a .torrent file couldn't be opened", async () => {
    sintelEngine();
    renderApp();

    act(() => {
      fakeStreamy.openTorrentFile({
        status: "error",
        message: "This file is bigger than 10 MB.",
      });
    });

    expect(
      await screen.findByText("Couldn't open the .torrent file"),
    ).toBeVisible();
    expect(screen.getByText("This file is bigger than 10 MB.")).toBeVisible();
  });

  it("never shows a system error about a .torrent file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sintelEngine();
    renderApp();

    act(() => {
      fakeStreamy.openTorrentFile({
        status: "error",
        message: "EISDIR: illegal operation on a directory, read",
      });
    });

    expect(
      await screen.findByText("It may be damaged, or not a .torrent file."),
    ).toBeVisible();
    expect(screen.queryByText(/EISDIR/)).not.toBeInTheDocument();
  });
});

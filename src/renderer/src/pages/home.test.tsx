import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  engineError,
  jsonResponse,
  mockEngine,
  noContent,
} from "@/test/engine";
import { fakeStreamy } from "@/test/fake-streamy";
import {
  continueItem,
  HASH,
  library,
  libraryTorrent,
  OTHER_HASH,
  torrentDetail,
} from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { wholeText } from "@/test/text";

describe("Home", () => {
  it("offers Sintel when there's nothing yet", async () => {
    mockEngine({ "GET /v1/library": library() });
    renderApp();

    expect(await screen.findByText("Nothing here yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Try Sintel" })).toBeVisible();
    expect(screen.queryByText("Continue watching")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });

  it("explains when the library can't be loaded, and tries again", async () => {
    const engine = mockEngine({
      "GET /v1/library": engineError(500, "INTERNAL", "The database is locked"),
    });
    const { user } = renderApp();

    expect(await screen.findByText("Couldn't load your library")).toBeVisible();
    // A sentence for people; the engine's details stay in the console.
    expect(
      screen.getByText(
        "The playback engine ran into a problem. Please try again.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("The database is locked")).toBeNull();

    engine.on("GET /v1/library", library());
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Nothing here yet")).toBeVisible();
  });

  it("says it's waiting while the engine starts", async () => {
    act(() => {
      fakeStreamy.setEngineStatus({ state: "starting", error: null });
    });
    mockEngine({ "GET /v1/library": library() });
    renderApp();

    expect(
      await screen.findByText("Waiting for the playback engine…"),
    ).toBeVisible();

    act(() => {
      fakeStreamy.setEngineStatus({ state: "running", error: null });
    });
    expect(await screen.findByText("Nothing here yet")).toBeVisible();
  });
});

describe("Continue watching", () => {
  it("shows what's left, and plays it", async () => {
    mockEngine({
      "GET /v1/library": library({
        continueWatching: [
          continueItem({
            fileName: "Episode 2.mkv",
            torrentName: "The Show",
            position: 300,
            duration: 1_020,
            fileIndex: 4,
          }),
        ],
      }),
    });
    const { user, router } = renderApp();

    const link = await screen.findByRole("link", { name: "Episode 2" });
    expect(screen.getByText("The Show")).toBeVisible();
    expect(screen.getByText("12 min left")).toBeVisible();

    await user.click(link);

    // The player loads on first use, so the page changes a moment later.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/watch/${HASH}/4`);
    });
    // It said "resume": the player doesn't ask again.
    expect(router.state.location.state).toEqual({ start: "resume" });
  });

  it("shows the thumbnail, or a placeholder when it can't load", async () => {
    mockEngine({
      "GET /v1/library": library({
        continueWatching: [
          continueItem({
            thumbnailUrl: `/v1/library/${HASH}/files/0/thumbnail`,
          }),
        ],
      }),
    });
    const { container } = renderApp();

    await screen.findByRole("link", { name: "Sintel" });
    const image = container.querySelector("img[loading=lazy]");
    expect(image).toHaveAttribute(
      "src",
      `app://streamy/api/v1/library/${HASH}/files/0/thumbnail`,
    );

    act(() => {
      image?.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("img[loading=lazy]")).toBeNull();
  });

  it("removes an item from the menu", async () => {
    const item = continueItem();
    const engine = mockEngine({
      "GET /v1/library": library({ continueWatching: [item] }),
      [`DELETE /v1/library/${HASH}/files/0`]: () => {
        engine.on("GET /v1/library", library());
        return noContent();
      },
    });
    const { user } = renderApp();

    await user.click(
      await screen.findByRole("button", { name: "More for Sintel" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Remove from Continue watching" }),
    );

    await waitFor(() => {
      expect(screen.queryByText("Continue watching")).not.toBeInTheDocument();
    });
    expect(engine.callsTo(`DELETE /v1/library/${HASH}/files/0`)).toHaveLength(
      1,
    );
  });

  it("lets its ⋯ menu open past the card's edge", async () => {
    mockEngine({
      "GET /v1/library": library({ continueWatching: [continueItem()] }),
    });
    const { user } = renderApp();

    const more = await screen.findByRole("button", { name: "More for Sintel" });
    await user.click(more);

    // The card used to clip everything to its rounded corners, the menu too.
    const card = more.closest("li");
    expect(card).not.toHaveClass("overflow-hidden");
    expect(screen.getByRole("menu")).toBeVisible();
  });

  it("can show all the torrent's files", async () => {
    mockEngine({
      "GET /v1/library": library({ continueWatching: [continueItem()] }),
      [`GET /v1/torrents/${HASH}`]: { torrent: torrentDetail() },
    });
    const { user, router } = renderApp();

    await user.click(
      await screen.findByRole("button", { name: "More for Sintel" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Show all files" }));

    expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });
});

describe("Recent", () => {
  it("lists torrents with their size, when they were opened and if active", async () => {
    mockEngine({
      "GET /v1/library": library({
        recent: [
          libraryTorrent({ name: "Sintel", active: true }),
          libraryTorrent({ infoHash: OTHER_HASH, name: "Big Buck Bunny" }),
        ],
      }),
      [`GET /v1/torrents/${OTHER_HASH}`]: {
        torrent: torrentDetail({
          infoHash: OTHER_HASH,
          name: "Big Buck Bunny",
        }),
      },
    });
    const { user, router } = renderApp();

    const list = within(await screen.findByRole("region", { name: "Recent" }));
    const items = list.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0] as HTMLElement).getByText("Active")).toBeVisible();
    expect(
      within(items[1] as HTMLElement).queryByText("Active"),
    ).not.toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText(
        /^129 MB · Opened 3 hours ago$/,
      ),
    ).toBeVisible();

    await user.click(list.getByRole("link", { name: "Big Buck Bunny" }));
    expect(router.state.location.pathname).toBe(`/torrent/${OTHER_HASH}`);
  });

  it("removes a torrent from Streamy after asking", async () => {
    const engine = mockEngine({
      "GET /v1/library": library({ recent: [libraryTorrent()] }),
      [`DELETE /v1/library/${HASH}`]: () => {
        engine.on("GET /v1/library", library());
        return noContent();
      },
    });
    const { user } = renderApp();

    await user.click(
      await screen.findByRole("button", { name: "Remove Sintel from Streamy" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove Sintel from Streamy?",
    });
    expect(engine.callsTo(`DELETE /v1/library/${HASH}`)).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(wholeText("Removed Sintel from Streamy")),
    ).toBeVisible();
    expect(engine.callsTo(`DELETE /v1/library/${HASH}`)).toHaveLength(1);
    expect(await screen.findByText("Nothing here yet")).toBeVisible();
  });

  it("can't be closed while it removes", async () => {
    let finish: () => void = () => undefined;
    mockEngine({
      "GET /v1/library": library({ recent: [libraryTorrent()] }),
      [`DELETE /v1/library/${HASH}`]: () =>
        new Promise<Response>((resolve) => {
          finish = () => {
            resolve(noContent());
          };
        }),
    });
    const { user } = renderApp();

    await user.click(
      await screen.findByRole("button", { name: "Remove Sintel from Streamy" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Remove Sintel from Streamy?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Remove" }));

    // Esc and a click on the backdrop do nothing while it runs.
    expect(fireEvent(dialog, new Event("cancel", { cancelable: true }))).toBe(
      false,
    );
    fireEvent.pointerDown(dialog);
    fireEvent.pointerUp(dialog);
    expect(dialog).toHaveAttribute("open");

    act(() => {
      finish();
    });
    expect(
      await screen.findByText(wholeText("Removed Sintel from Streamy")),
    ).toBeVisible();
    expect(dialog).not.toHaveAttribute("open");
  });

  it("writes right-to-left names from their own side", async () => {
    const name = "סרט הבית";
    mockEngine({
      "GET /v1/library": library({
        recent: [libraryTorrent({ name })],
        continueWatching: [
          continueItem({ fileName: `${name}.mkv`, torrentName: name }),
        ],
      }),
    });
    renderApp();

    // dir="auto": cut at its own end (the left) when it's too long.
    const recent = within(
      await screen.findByRole("region", { name: "Recent" }),
    );
    expect(recent.getByRole("link", { name })).toHaveAttribute("dir", "auto");
    const continueWatching = within(
      screen.getByRole("region", { name: "Continue watching" }),
    );
    expect(continueWatching.getByRole("link", { name })).toHaveAttribute(
      "dir",
      "auto",
    );
  });

  it("keeps the dialog open with the reason when removing fails", async () => {
    mockEngine({
      "GET /v1/library": library({ recent: [libraryTorrent()] }),
      [`DELETE /v1/library/${HASH}`]: engineError(
        500,
        "INTERNAL",
        "The database is locked",
      ),
    });
    const { user } = renderApp();

    await user.click(
      await screen.findByRole("button", { name: "Remove Sintel from Streamy" }),
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    // What went wrong inside the engine stays in the console.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The playback engine ran into a problem. Please try again.",
    );
    expect(
      screen.getByRole("dialog", { name: "Remove Sintel from Streamy?" }),
    ).toBeVisible();
  });
});

describe("the IP address notice", () => {
  it("shows after the first torrent is added, until dismissed", async () => {
    mockEngine({
      "GET /v1/library": library(),
      "POST /v1/torrents": { torrent: torrentDetail({ files: [] }) },
      [`GET /v1/torrents/${HASH}`]: { torrent: torrentDetail({ files: [] }) },
    });
    const first = renderApp();
    expect(screen.queryByText(/can see your IP address/)).toBeNull();

    await first.user.type(
      screen.getByRole("textbox", { name: "Magnet link or info hash" }),
      HASH,
    );
    await first.user.click(screen.getByRole("button", { name: "Play" }));

    expect(
      await screen.findByText(
        "Peers can see your IP address while a torrent is active.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText("That's how torrents work. A VPN keeps it private."),
    ).toBeVisible();

    await first.user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/can see your IP address/)).toBeNull();
    first.unmount();

    // Never again, even after adding another one.
    const second = renderApp();
    await second.user.type(
      screen.getByRole("textbox", { name: "Magnet link or info hash" }),
      HASH,
    );
    await second.user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => {
      expect(second.router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(screen.queryByText(/can see your IP address/)).toBeNull();
  });
});

describe("adding while the engine is slow", () => {
  /** POST /v1/torrents answers only when `finish` is called. */
  function slowAdd() {
    let finish: () => void = () => undefined;
    const engine = mockEngine({
      "GET /v1/library": library(),
      "POST /v1/torrents": () =>
        new Promise<Response>((resolve) => {
          finish = () => {
            resolve(jsonResponse({ torrent: torrentDetail({ files: [] }) }));
          };
        }),
      [`GET /v1/torrents/${HASH}`]: { torrent: torrentDetail({ files: [] }) },
      [`GET /v1/torrents/${OTHER_HASH}`]: {
        torrent: torrentDetail({
          infoHash: OTHER_HASH,
          name: "Big Buck Bunny",
        }),
      },
    });
    return {
      engine,
      finish: () => {
        finish();
      },
    };
  }

  async function startAdding(view: ReturnType<typeof renderApp>) {
    await view.user.type(
      await screen.findByRole("textbox", { name: "Magnet link or info hash" }),
      HASH,
    );
    await view.user.click(screen.getByRole("button", { name: "Play" }));
  }

  it("opens the torrent when the user is still where they added it", async () => {
    const { finish } = slowAdd();
    const view = renderApp();
    await startAdding(view);

    act(() => {
      finish();
    });

    await waitFor(() => {
      expect(view.router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
  });

  // E.g. added while the engine was starting, then went on to watch
  // something else: being pulled away from the movie would be rude.
  it("doesn't pull the user away from where they went meanwhile", async () => {
    const { engine, finish } = slowAdd();
    const view = renderApp();
    await startAdding(view);
    await waitFor(() => {
      expect(engine.callsTo("POST /v1/torrents")).toHaveLength(1);
    });

    await act(() => view.router.navigate(`/torrent/${OTHER_HASH}`));
    act(() => {
      finish();
    });

    const open = await screen.findByRole("button", { name: "Open" });
    expect(screen.getByText(wholeText("Added Sintel"))).toBeVisible();
    expect(view.router.state.location.pathname).toBe(`/torrent/${OTHER_HASH}`);

    await view.user.click(open);
    expect(view.router.state.location.pathname).toBe(`/torrent/${HASH}`);
  });
});

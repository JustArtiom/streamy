import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AddTorrentBox } from "@/components/torrent/add-torrent-box";
import { engineError, mockEngine } from "@/test/engine";
import { HASH, torrentDetail } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`;
const torrent = torrentDetail({
  name: null,
  status: "fetching_metadata",
  size: null,
  files: [],
});

function setup(routes: Parameters<typeof mockEngine>[0] = {}) {
  const engine = mockEngine(routes);
  const view = renderWithProviders(<AddTorrentBox />);
  const input = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Magnet link or info hash",
  });
  return { ...view, engine, input };
}

describe("AddTorrentBox", () => {
  it("asks for a link when submitted empty, without calling the engine", async () => {
    const { engine, input, user } = setup();

    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(
      screen.getByText("Paste a magnet link or an info hash"),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Paste a magnet link or an info hash",
    );
    expect(engine.calls).toHaveLength(0);
  });

  it("explains what's wrong with something that isn't a magnet", async () => {
    const { engine, input, user } = setup();

    await user.type(input, "https://example.com/movie");
    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(screen.getByText(/doesn't look like a magnet link/)).toBeVisible();
    expect(engine.calls).toHaveLength(0);
  });

  it("adds a magnet and opens its page", async () => {
    const { engine, input, user, router } = setup({
      "POST /v1/torrents": { torrent },
    });

    await user.type(input, MAGNET);
    await user.click(screen.getByRole("button", { name: "Play" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(router.state.location.state).toEqual({ justAdded: true });
    expect(engine.callsTo("POST /v1/torrents")[0]?.body).toEqual({
      magnet: MAGNET,
    });
  });

  it("shows the engine's reason next to the field", async () => {
    const { input, user, router } = setup({
      "POST /v1/torrents": engineError(
        400,
        "VALIDATION_FAILED",
        "Some fields are invalid",
        [
          {
            path: "body.magnet",
            message: "BitTorrent v2-only magnets aren't supported yet",
          },
        ],
      ),
    });

    await user.type(input, "magnet:?xt=urn:btmh:1220abcd");
    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(
      await screen.findByText(
        "BitTorrent v2-only magnets aren't supported yet",
      ),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(router.state.location.pathname).toBe("/");
  });

  it("shows other engine errors too (e.g. too many torrents)", async () => {
    const { input, user } = setup({
      "POST /v1/torrents": engineError(
        503,
        "SERVICE_UNAVAILABLE",
        "Too many torrents at once",
      ),
    });

    await user.type(input, HASH);
    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(await screen.findByText("Too many torrents at once")).toBeVisible();
  });

  it("adds a pasted magnet right away", async () => {
    const { engine, input, user, router } = setup({
      "POST /v1/torrents": { torrent },
    });

    await user.click(input);
    await user.paste(MAGNET);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(engine.calls).toHaveLength(1);
  });

  it("only fills in pasted text that isn't a magnet", async () => {
    const { engine, input, user } = setup();

    await user.click(input);
    await user.paste("hello");

    expect(input).toHaveValue("hello");
    expect(engine.calls).toHaveLength(0);
  });

  it("opens a picked .torrent file, sent as raw bytes", async () => {
    const { engine, user, router } = setup({
      "POST /v1/torrents/file": { torrent },
    });
    const file = new File(["d8:announce…"], "sintel.torrent", {
      type: "application/x-bittorrent",
    });

    await user.upload(screen.getByLabelText("Choose a .torrent file"), file);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/torrent/${HASH}`);
    });
    expect(engine.callsTo("POST /v1/torrents/file")[0]?.body).toBe(file);
  });

  it("the button opens the file picker", async () => {
    const { user } = setup();
    const picker = screen.getByLabelText<HTMLInputElement>(
      "Choose a .torrent file",
    );
    let opened = false;
    picker.addEventListener("click", () => {
      opened = true;
    });

    await user.click(
      screen.getByRole("button", { name: "Open a .torrent file" }),
    );

    expect(opened).toBe(true);
  });

  it("refuses a file that isn't a .torrent", async () => {
    const { engine } = setup();
    const file = new File(["hi"], "notes.txt", { type: "text/plain" });

    // applyAccept: false = like dropping it, where `accept` doesn't filter.
    await userEvent
      .setup({ applyAccept: false })
      .upload(screen.getByLabelText("Choose a .torrent file"), file);

    expect(screen.getByText(`"notes.txt" isn't a .torrent file`)).toBeVisible();
    expect(engine.calls).toHaveLength(0);
  });

  it("⌘K focuses and selects the box", async () => {
    const { input, user } = setup();
    await user.type(input, HASH);
    await user.click(document.body);

    await user.keyboard("{Meta>}k{/Meta}");

    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(HASH.length);
  });
});

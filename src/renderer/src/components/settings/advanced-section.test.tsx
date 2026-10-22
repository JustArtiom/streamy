import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../../shared/api";
import type { Health } from "../../../../shared/engine-api";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { fakeStreamy, INITIAL_SNAPSHOT } from "@/test/fake-streamy";

// The parts of Settings → Advanced about Streamy itself: its version, updates
// and third-party licences. (The engine rows are tested in
// settings-dialog.test.tsx.)

const { api } = fakeStreamy;

const NOTICES_URL = "app://streamy/third-party-notices.txt";
const HEALTH: Health = {
  version: "0.1.0",
  uptime: 5,
  ffmpeg: { version: "8.1.3-Jellyfin", error: null },
  encoder: null,
  lowDiskSpace: false,
};

const fetchMock = vi.fn<typeof fetch>();

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

beforeEach(() => {
  fetchMock.mockImplementation((input) =>
    Promise.resolve(
      urlOf(input) === NOTICES_URL
        ? new Response("THIRD-PARTY NOTICES FOR STREAMY 0.1.0\n\nreact 19.3.1")
        : Response.json(HEALTH),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSection(snapshot = INITIAL_SNAPSHOT) {
  const user = userEvent.setup();
  render(<AdvancedSection snapshot={snapshot} />);
  return { user };
}

function setStatus(status: UpdateStatus) {
  act(() => {
    fakeStreamy.setUpdateStatus(status);
  });
}

describe("version and updates", () => {
  it("shows the version, and checks for updates when asked", async () => {
    const { user } = renderSection();
    expect(await screen.findByText("Streamy 0.0.0")).toBeInTheDocument();
    expect(
      screen.getByText("Streamy checks for updates by itself."),
    ).toBeInTheDocument();

    api.updates.check.mockResolvedValueOnce({
      state: "idle",
      checkedAt: new Date().toISOString(),
    });
    await user.click(screen.getByRole("button", { name: "Check for updates" }));

    expect(api.updates.check).toHaveBeenCalledOnce();
    expect(
      await screen.findByText("Up to date. Checked just now."),
    ).toBeInTheDocument();
  });

  it("doesn't claim to check by itself when that's turned off", async () => {
    renderSection({
      ...INITIAL_SNAPSHOT,
      settings: { ...INITIAL_SNAPSHOT.settings, checkForUpdates: false },
    });

    expect(
      await screen.findByText("Automatic checks are off."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Streamy checks for updates by itself."),
    ).not.toBeInTheDocument();
    // Checking by hand still works.
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeEnabled();
  });

  it("is busy while checking", () => {
    renderSection();
    setStatus({ state: "checking" });

    expect(screen.getByText("Checking for updates…")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeDisabled();
  });

  it("shows the download's progress", () => {
    renderSection();
    setStatus({ state: "downloading", version: "0.2.0", percent: 40 });

    expect(
      screen.getByText("Downloading version 0.2.0… 40%"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).not.toBeInTheDocument();
  });

  it("restarts to install a downloaded update", async () => {
    const { user } = renderSection();
    setStatus({ state: "ready", version: "0.2.0" });

    expect(
      screen.getByText(
        "Version 0.2.0 is ready. It installs when Streamy restarts.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restart to update" }));

    expect(api.updates.install).toHaveBeenCalledOnce();
  });

  it("links to the download on macOS", async () => {
    const { user } = renderSection();
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    expect(screen.getByText("Version 0.2.0 is available.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(api.updates.openReleasePage).toHaveBeenCalledOnce();
  });

  it("says why a check failed, and tries again", async () => {
    const { user } = renderSection();
    setStatus({
      state: "error",
      message: "Couldn't reach GitHub. Check your internet connection.",
    });

    expect(
      screen.getByText(
        "Couldn't reach GitHub. Check your internet connection.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(api.updates.check).toHaveBeenCalledOnce();
  });

  it("never shows the updater's raw error", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderSection();
    setStatus({
      state: "error",
      message:
        "net::ERR_INTERNET_DISCONNECTED at ClientRequest.<anonymous> (/app/out/main/index.js:1:2)",
    });

    expect(screen.getByText("Couldn't check for updates.")).toBeInTheDocument();
    expect(screen.queryByText(/ERR_INTERNET/)).not.toBeInTheDocument();
  });

  it("points to GitHub when this copy can't update itself", async () => {
    const { user } = renderSection();
    setStatus({ state: "unsupported" });

    expect(
      screen.getByText(/this copy of streamy doesn't update itself/i),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Releases" }));

    expect(api.updates.openReleasePage).toHaveBeenCalledOnce();
  });

  it("says when the browser couldn't be opened", async () => {
    api.updates.openReleasePage.mockResolvedValueOnce({
      status: "error",
      message: "Couldn't open your browser.",
    });
    const { user } = renderSection();
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't open your browser.",
    );
  });
});

describe("third-party licences", () => {
  it("shows the licences shipped with the app", async () => {
    const { user } = renderSection();

    await user.click(
      screen.getByRole("button", { name: "View third-party licences" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Third-party licences" });
    expect(
      await within(dialog).findByText(/THIRD-PARTY NOTICES FOR STREAMY/),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(NOTICES_URL, expect.anything());

    await user.click(
      within(dialog).getByRole("button", { name: "Close licences" }),
    );
    expect(dialog).not.toHaveAttribute("open");
  });

  it("says when the file is missing, and tries again next time", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        urlOf(input) === NOTICES_URL
          ? new Response(null, { status: 404 })
          : Response.json(HEALTH),
      ),
    );
    const { user } = renderSection();
    const view = () =>
      user.click(
        screen.getByRole("button", { name: "View third-party licences" }),
      );

    await view();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /licences file is missing/,
    );

    await user.click(screen.getByRole("button", { name: "Close licences" }));
    await view();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => urlOf(input) === NOTICES_URL),
      ).toHaveLength(2);
    });
  });
});

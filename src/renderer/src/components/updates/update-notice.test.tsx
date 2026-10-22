import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../../shared/api";
import { Announcer } from "@/components/layout/announcer";
import { UpdateNotice } from "@/components/updates/update-notice";
import { resetUpdateNoticeForTests } from "@/components/updates/update-status";
import { fakeStreamy } from "@/test/fake-streamy";
import { renderWithProviders } from "@/test/render";

const { api } = fakeStreamy;

afterEach(() => {
  resetUpdateNoticeForTests();
});

function setStatus(status: UpdateStatus) {
  act(() => {
    fakeStreamy.setUpdateStatus(status);
  });
}

/** The notice, with the live region that announces it (as in AppLayout). */
function renderNotice() {
  return renderWithProviders(
    <>
      <Announcer />
      <UpdateNotice />
    </>,
  );
}

/** What the live region says about it, or null when it says nothing. */
const notice = () => {
  const region = screen.getByRole("status");
  return region.textContent === "" ? null : region;
};

describe("UpdateNotice", () => {
  it.each<[string, UpdateStatus]>([
    ["up to date", { state: "idle", checkedAt: null }],
    ["it can't update", { state: "unsupported" }],
    ["checking", { state: "checking" }],
    ["downloading", { state: "downloading", version: "0.2.0", percent: 40 }],
    [
      "about to download",
      { state: "available", version: "0.2.0", canInstall: true },
    ],
    ["a check failed", { state: "error", message: "Couldn't reach GitHub." }],
  ])("says nothing when %s", (_when, status) => {
    renderNotice();
    setStatus(status);

    expect(notice()).not.toBeInTheDocument();
  });

  it("offers to restart once an update is ready", async () => {
    const { user } = renderNotice();
    setStatus({ state: "ready", version: "0.2.0" });

    expect(notice()).toHaveTextContent(
      "Streamy 0.2.0 is ready. It installs when Streamy restarts.",
    );
    const restart = screen.getByRole("button", { name: "Restart to update" });
    await user.click(restart);

    expect(api.updates.install).toHaveBeenCalledOnce();
    // Streamy is about to quit: the button stays busy.
    expect(restart).toBeDisabled();
  });

  it("says so if it couldn't restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    api.updates.install.mockRejectedValueOnce(new Error("IPC failed"));
    const { user } = renderNotice();
    setStatus({ state: "ready", version: "0.2.0" });

    await user.click(screen.getByRole("button", { name: "Restart to update" }));

    expect(
      await screen.findByText("Couldn't restart to update"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Restart to update" }),
    ).toBeEnabled();
  });

  it("links to the download on macOS", async () => {
    const { user } = renderNotice();
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    expect(notice()).toHaveTextContent("Streamy 0.2.0 is available.");
    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(api.updates.openReleasePage).toHaveBeenCalledOnce();
  });

  it("says when the browser couldn't be opened", async () => {
    api.updates.openReleasePage.mockResolvedValueOnce({
      status: "error",
      message: "Couldn't open your browser.",
    });
    const { user } = renderNotice();
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(
      await screen.findByText("Couldn't open the download page"),
    ).toBeInTheDocument();
    expect(screen.getByText("Couldn't open your browser.")).toBeInTheDocument();
  });

  it("hides for this session with Later, until there's news", async () => {
    const { user } = renderNotice();
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(notice()).not.toBeInTheDocument();

    // The same news again (e.g. the next check) stays hidden.
    setStatus({ state: "checking" });
    setStatus({ state: "available", version: "0.2.0", canInstall: false });
    expect(notice()).not.toBeInTheDocument();

    // A newer version is news.
    setStatus({ state: "available", version: "0.3.0", canInstall: false });
    expect(notice()).toHaveTextContent("Streamy 0.3.0 is available.");
  });

  it("shows a ready update even after its download notice was dismissed", async () => {
    const { user } = renderNotice();
    setStatus({ state: "ready", version: "0.2.0" });
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(notice()).not.toBeInTheDocument();

    setStatus({ state: "ready", version: "0.2.1" });
    expect(notice()).toHaveTextContent("Streamy 0.2.1 is ready.");
  });
});

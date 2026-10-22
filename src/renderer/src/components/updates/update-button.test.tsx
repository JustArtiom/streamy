import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../../shared/api";
import { Announcer } from "@/components/layout/announcer";
import { TitleBar } from "@/components/title-bar";
import { UpdateButton } from "@/components/updates/update-button";
import { fakeStreamy } from "@/test/fake-streamy";
import { renderWithProviders } from "@/test/render";

const { api } = fakeStreamy;

function setStatus(status: UpdateStatus) {
  act(() => {
    fakeStreamy.setUpdateStatus(status);
  });
}

const updateButton = () =>
  screen.queryByRole("button", { name: /update to streamy|download streamy/i });

describe("UpdateButton", () => {
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
  ])("isn't there when %s", (_when, status) => {
    renderWithProviders(<UpdateButton />);
    setStatus(status);

    expect(updateButton()).not.toBeInTheDocument();
  });

  it("restarts into the update once it's ready", async () => {
    const { user } = renderWithProviders(<UpdateButton />);
    setStatus({ state: "ready", version: "0.2.0" });

    const button = screen.getByRole("button", {
      name: "Restart to update to Streamy 0.2.0",
    });
    await user.click(button);

    expect(api.updates.install).toHaveBeenCalledOnce();
    // Streamy is quitting: no second click.
    expect(button).toBeDisabled();
  });

  it("comes back if restarting fails", async () => {
    vi.mocked(api.updates.install).mockRejectedValueOnce(
      new Error("Couldn't start the installer."),
    );
    const { user } = renderWithProviders(<UpdateButton />);
    setStatus({ state: "ready", version: "0.2.0" });

    const button = screen.getByRole("button", {
      name: "Restart to update to Streamy 0.2.0",
    });
    await user.click(button);

    await waitFor(() => {
      expect(button).toBeEnabled();
    });
  });

  it("opens the download page on macOS (it can't update itself)", async () => {
    const { user } = renderWithProviders(<UpdateButton />);
    setStatus({ state: "available", version: "0.2.0", canInstall: false });

    await user.click(
      screen.getByRole("button", { name: "Download Streamy 0.2.0" }),
    );

    expect(api.updates.openReleasePage).toHaveBeenCalledOnce();
    expect(api.updates.install).not.toHaveBeenCalled();
  });

  it("is announced to screen readers when it appears, and not before", () => {
    renderWithProviders(
      <>
        <Announcer />
        <UpdateButton />
      </>,
    );
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    setStatus({ state: "ready", version: "0.2.0" });

    expect(region).toHaveTextContent("Restart to update to Streamy 0.2.0");
  });

  it("sits in the title bar, just left of Settings", () => {
    renderWithProviders(<TitleBar />);
    setStatus({ state: "ready", version: "0.2.0" });

    const buttons = within(screen.getByRole("banner")).getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Restart to update to Streamy 0.2.0",
      "Settings",
    ]);
    // Clicking it must not drag the window.
    expect(buttons[0]).toHaveClass("no-drag-region");
  });
});

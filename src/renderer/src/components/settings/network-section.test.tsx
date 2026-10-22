import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { openSettings } from "@/lib/settings";
import { fakeStreamy, INITIAL_SNAPSHOT } from "@/test/fake-streamy";

const { api } = fakeStreamy;

async function renderNetwork() {
  const user = userEvent.setup();
  render(<SettingsDialog />);
  act(() => {
    openSettings();
  });
  await user.click(screen.getByRole("button", { name: "Network" }));
  return user;
}

function optionLabels(select: HTMLElement) {
  return Array.from(select.querySelectorAll("option")).map(
    (option) => option.textContent,
  );
}

describe("Settings → Network", () => {
  it("limits the download speed, or not", async () => {
    const user = await renderNetwork();
    const download = screen.getByRole("combobox", { name: "Download limit" });
    expect(download).toHaveDisplayValue("Unlimited");
    // Written like speeds (1 KB = 1000 bytes), so they compare at a glance.
    expect(optionLabels(download)).toEqual([
      "Unlimited",
      "250 kB/s",
      "500 kB/s",
      "1 MB/s",
      "2 MB/s",
      "5 MB/s",
      "10 MB/s",
      "20 MB/s",
      "50 MB/s",
    ]);

    await user.selectOptions(download, "1 MB/s");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      downloadLimitKBps: 1000,
    });

    await user.selectOptions(download, "Unlimited");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      downloadLimitKBps: null,
    });
  });

  it("limits the upload speed", async () => {
    const user = await renderNetwork();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Upload limit" }),
      "500 kB/s",
    );

    expect(api.settings.update).toHaveBeenLastCalledWith({
      uploadLimitKBps: 500,
    });
  });

  it("keeps sharing for a while, and explains why", async () => {
    const user = await renderNetwork();
    const sharing = screen.getByRole("combobox", {
      name: "Keep sharing after watching",
    });
    expect(sharing).toHaveDisplayValue("10 minutes");
    expect(optionLabels(sharing)).toEqual([
      "Off",
      "10 minutes",
      "1 hour",
      "Until Streamy quits",
    ]);
    expect(sharing).toHaveAccessibleDescription(
      /fair to them; Streamy stops when the time is up/,
    );

    await user.selectOptions(sharing, "Until Streamy quits");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      keepSharingMinutes: null,
    });
    await user.selectOptions(sharing, "Off");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      keepSharingMinutes: 0,
    });
  });

  it("changes the number of connections", async () => {
    const user = await renderNetwork();
    const connections = screen.getByRole("combobox", {
      name: "Max connections",
    });
    expect(connections).toHaveDisplayValue("100");

    await user.selectOptions(connections, "50");

    expect(api.settings.update).toHaveBeenLastCalledWith({
      maxConnections: 50,
    });
  });

  it("shows values edited by hand in settings.json", async () => {
    await renderNetwork();

    act(() => {
      fakeStreamy.emit({
        ...INITIAL_SNAPSHOT,
        settings: {
          ...INITIAL_SNAPSHOT.settings,
          downloadLimitKBps: 3500,
          keepSharingMinutes: 30,
          maxConnections: 75,
        },
      });
    });

    expect(
      screen.getByRole("combobox", { name: "Download limit" }),
    ).toHaveDisplayValue("3.5 MB/s");
    expect(
      screen.getByRole("combobox", { name: "Keep sharing after watching" }),
    ).toHaveDisplayValue("30 minutes");
    expect(
      screen.getByRole("combobox", { name: "Max connections" }),
    ).toHaveDisplayValue("75");
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { closeSettings, openSettings } from "@/lib/settings";
import {
  DEFAULT_CACHE_DIR,
  fakeStreamy,
  INITIAL_SNAPSHOT,
  INITIAL_SYSTEM,
} from "@/test/fake-streamy";

const { api } = fakeStreamy;

beforeEach(() => {
  act(() => {
    fakeStreamy.reset();
    closeSettings();
  });
});

function getDialog(container: HTMLElement) {
  const dialog = container.querySelector("dialog");
  if (!dialog) throw new Error("No <dialog> rendered");
  return dialog;
}

/** Renders the dialog, opens it and goes to one section. */
async function renderSection(section: string) {
  const user = userEvent.setup();
  const view = render(<SettingsDialog />);
  act(() => {
    openSettings();
  });
  await user.click(screen.getByRole("button", { name: section }));
  return { user, dialog: getDialog(view.container) };
}

function changeSettings(patch: Partial<typeof INITIAL_SNAPSHOT.settings>) {
  act(() => {
    fakeStreamy.emit({
      ...INITIAL_SNAPSHOT,
      settings: { ...INITIAL_SNAPSHOT.settings, ...patch },
    });
  });
}

describe("opening and closing", () => {
  it("opens from the app menu (⌘,)", () => {
    const { container } = render(<SettingsDialog />);
    expect(getDialog(container)).not.toHaveAttribute("open");

    act(() => {
      fakeStreamy.openFromMenu();
    });

    expect(getDialog(container)).toHaveAttribute("open");
  });

  it("closes with the close button", async () => {
    const { user, dialog } = await renderSection("General");

    await user.click(screen.getByRole("button", { name: "Close settings" }));

    expect(dialog).not.toHaveAttribute("open");
  });
});

describe("General", () => {
  it("turns on open at login and magnet links", async () => {
    const { user } = await renderSection("General");
    const login = await screen.findByRole("switch", { name: "Open at login" });

    await user.click(login);
    await user.click(
      screen.getByRole("switch", { name: "Open magnet links with Streamy" }),
    );

    expect(api.system.setOpenAtLogin).toHaveBeenCalledWith(true);
    expect(api.system.setHandlesMagnetLinks).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(login).toBeChecked();
    });
  });

  it("can't be changed from a dev build, and says why", async () => {
    act(() => {
      fakeStreamy.reset({ ...INITIAL_SYSTEM, available: false });
    });
    await renderSection("General");

    const login = await screen.findByRole("switch", { name: "Open at login" });
    expect(login).toBeDisabled();
    expect(login).toHaveAccessibleDescription(
      /only works in the installed app/i,
    );
  });

  it("explains when macOS still needs the user's approval", async () => {
    act(() => {
      fakeStreamy.reset({
        ...INITIAL_SYSTEM,
        openAtLogin: true,
        openAtLoginNeedsApproval: true,
      });
    });
    await renderSection("General");

    expect(
      await screen.findByRole("switch", { name: "Open at login" }),
    ).toHaveAccessibleDescription(/system settings/i);
  });
});

describe("Appearance", () => {
  it("shows the current theme and changes it", async () => {
    const { user } = await renderSection("Appearance");
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(api.settings.update).toHaveBeenCalledWith({ theme: "dark" });
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  });

  it("changes the interface size", async () => {
    const { user } = await renderSection("Appearance");
    expect(screen.getByRole("radio", { name: "100%" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "125%" }));

    expect(api.settings.update).toHaveBeenCalledWith({ uiScale: 1.25 });
  });

  it("follows a change made somewhere else (e.g. ⌘+ in the menu)", async () => {
    await renderSection("Appearance");

    changeSettings({ theme: "light", uiScale: 1.1 });

    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "110%" })).toBeChecked();
  });
});

describe("Storage", () => {
  it("shows the default video folder", async () => {
    await renderSection("Storage");

    expect(screen.getByText(DEFAULT_CACHE_DIR)).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
  });

  it("shows a chosen folder, with a way back to the default", async () => {
    const { user } = await renderSection("Storage");
    changeSettings({ cacheDir: "/Volumes/Big/Streamy" });
    expect(screen.getByText("/Volumes/Big/Streamy")).toBeInTheDocument();
    expect(screen.queryByText("Default")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Use default" }));

    expect(api.settings.resetCacheDir).toHaveBeenCalledOnce();
    expect(screen.getByText(DEFAULT_CACHE_DIR)).toBeInTheDocument();
  });

  it("explains why a chosen folder can't be used", async () => {
    const { user } = await renderSection("Storage");
    api.settings.chooseCacheDir.mockResolvedValueOnce({
      status: "error",
      message: "Streamy can't save files in that folder.",
    });

    await user.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Streamy can't save files in that folder.",
    );
  });

  it("shows the folder in Finder", async () => {
    const { user } = await renderSection("Storage");

    await user.click(screen.getByRole("button", { name: "Show in Finder" }));

    expect(api.settings.showCacheDir).toHaveBeenCalledOnce();
  });

  it("shows the space used, and clears it after asking", async () => {
    api.settings.getCacheUsage.mockResolvedValue({
      status: "ok",
      bytes: 3_400_000_000,
    });
    const { user } = await renderSection("Storage");
    // "3.4 GB" (or "3,4 GB", depending on the machine's language)
    expect(await screen.findByText(/^3[.,]4 GB$/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear now…" }));
    expect(api.settings.clearCache).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear videos" }));

    expect(api.settings.clearCache).toHaveBeenCalledOnce();
  });

  it("says when the chosen folder isn't available", async () => {
    api.settings.getCacheUsage.mockResolvedValue({ status: "missing" });
    await renderSection("Storage");

    expect(
      await screen.findByText(/the folder isn't available/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear now…" })).toBeDisabled();
  });

  it("changes the size limit", async () => {
    const { user } = await renderSection("Storage");
    const limit = screen.getByRole("combobox", { name: "Size limit" });
    expect(limit).toHaveValue("20");

    await user.selectOptions(limit, "No limit");

    expect(api.settings.update).toHaveBeenCalledWith({ cacheLimitGb: null });
  });
});

describe("Advanced", () => {
  it("asks for a restart after changing hardware acceleration", async () => {
    const { user } = await renderSection("Advanced");
    expect(screen.queryByText(/restart streamy/i)).toBeNull();

    await user.click(
      screen.getByRole("switch", { name: "Hardware acceleration" }),
    );

    expect(api.settings.update).toHaveBeenCalledWith({
      hardwareAcceleration: false,
    });
    expect(screen.getByText(/restart streamy to apply/i)).toBeInTheDocument();
  });

  it("resets all settings after asking", async () => {
    const { user } = await renderSection("Advanced");

    await user.click(screen.getByRole("button", { name: "Reset…" }));
    expect(api.settings.reset).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(api.settings.reset).toHaveBeenCalledOnce();
  });
});

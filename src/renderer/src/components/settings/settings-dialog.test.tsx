import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Health } from "../../../../shared/engine-api";
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

  it("starts the sections over each time it opens", async () => {
    api.settings.getCacheUsage.mockResolvedValue({
      status: "ok",
      bytes: 3_400_000_000,
    });
    const { user } = await renderSection("Storage");
    expect(await screen.findByText("3.4 GB")).toBeInTheDocument();

    // Cleared from somewhere else while the dialog was closed.
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    await waitFor(() => {
      expect(screen.queryByText("Space used")).not.toBeInTheDocument();
    });
    api.settings.getCacheUsage.mockResolvedValue({ status: "ok", bytes: 0 });
    act(() => {
      openSettings();
    });

    // Measured again: not the old number, and nothing left to clear.
    expect(await screen.findByText("0 bytes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear now…" })).toBeDisabled();
    expect(api.settings.getCacheUsage).toHaveBeenCalledTimes(2);
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

  it("explains that the Linux AppImage can't open magnet links", async () => {
    act(() => {
      fakeStreamy.reset({ ...INITIAL_SYSTEM, canHandleMagnetLinks: false });
    });
    await renderSection("General");

    const magnet = await screen.findByRole("switch", {
      name: "Open magnet links with Streamy",
    });
    expect(magnet).toBeDisabled();
    expect(magnet).toHaveAccessibleDescription(/install the \.deb/i);
  });

  it("has the update switch in About, not here", async () => {
    await renderSection("General");
    await screen.findByRole("switch", { name: "Open at login" });

    expect(
      screen.queryByRole("switch", { name: "Check for updates automatically" }),
    ).not.toBeInTheDocument();
  });

  it("checks for updates automatically, unless turned off (About)", async () => {
    const { user } = await renderSection("About");
    const updates = await screen.findByRole("switch", {
      name: "Check for updates automatically",
    });
    expect(updates).toBeChecked();
    // Turning it off is a privacy choice: say who it talks to.
    expect(updates).toHaveAccessibleDescription(/GitHub/);

    await user.click(updates);

    expect(api.settings.update).toHaveBeenCalledWith({
      checkForUpdates: false,
    });
    expect(updates).not.toBeChecked();
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

  it("never shows a system error from the main process", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { user } = await renderSection("Storage");
    api.settings.chooseCacheDir.mockResolvedValueOnce({
      status: "error",
      message: "EACCES: permission denied, mkdir '/Volumes/Big/Streamy'",
    });

    await user.click(screen.getByRole("button", { name: "Change…" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Something went wrong. Please try again.",
    );
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

  it("can't be closed while it clears", async () => {
    api.settings.getCacheUsage.mockResolvedValue({ status: "ok", bytes: 10 });
    let finish: () => void = () => undefined;
    api.settings.clearCache.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({ status: "ok" });
          };
        }),
    );
    const { user } = await renderSection("Storage");
    await user.click(await screen.findByRole("button", { name: "Clear now…" }));
    const confirm = screen.getByRole("dialog", { name: "Clear all videos?" });

    await user.click(screen.getByRole("button", { name: "Clear videos" }));

    expect(fireEvent(confirm, new Event("cancel", { cancelable: true }))).toBe(
      false,
    );
    fireEvent.pointerDown(confirm);
    fireEvent.pointerUp(confirm);
    expect(confirm).toHaveAttribute("open");

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(confirm).not.toHaveAttribute("open");
    });
  });

  it("says when the chosen folder isn't available", async () => {
    api.settings.getCacheUsage.mockResolvedValue({ status: "missing" });
    await renderSection("Storage");

    expect(
      await screen.findByText(/the folder isn't available/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear now…" })).toBeDisabled();
  });

  it("says videos stay in the old folder after a change, and shows it", async () => {
    const { user } = await renderSection("Storage");
    expect(screen.queryByText(/stay in the old folder/i)).toBeNull();

    act(() => {
      fakeStreamy.emit({
        ...INITIAL_SNAPSHOT,
        settings: { ...INITIAL_SNAPSHOT.settings, cacheDir: "/Volumes/Big" },
        previousCacheDir: DEFAULT_CACHE_DIR,
      });
    });
    expect(screen.getByText(/stay in the old folder/i)).toHaveTextContent(
      DEFAULT_CACHE_DIR,
    );

    await user.click(screen.getByRole("button", { name: "Show old folder" }));
    expect(api.settings.showPreviousCacheDir).toHaveBeenCalledOnce();
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
  const HEALTH: Health = {
    version: "0.1.0",
    uptime: 5,
    ffmpeg: { version: "8.1.3-Jellyfin", error: null },
    encoder: "h264_videotoolbox",
    lowDiskSpace: false,
  };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(HEALTH)));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const engineLine = () =>
    screen.getByText(
      (_text, element) => element?.getAttribute("role") === "status",
    );

  it("keeps both graphics card switches together", async () => {
    const { user } = await renderSection("Advanced");

    expect(
      screen.getByRole("switch", { name: "Hardware acceleration" }),
    ).toBeChecked();
    const encoding = screen.getByRole("radiogroup", {
      name: "Hardware video encoding",
    });
    expect(
      within(encoding).getByRole("radio", { name: "Automatic" }),
    ).toBeChecked();
    expect(screen.getByText(/your graphics card does it faster/)).toBeVisible();

    await user.click(within(encoding).getByRole("radio", { name: "Off" }));

    expect(api.settings.update).toHaveBeenCalledWith({
      hardwareEncoding: "off",
    });
  });

  it("shows the engine's state, its ffmpeg and its encoder", async () => {
    await renderSection("Advanced");

    await waitFor(() => {
      expect(engineLine()).toHaveTextContent(
        "Running · ffmpeg 8.1.3 · VideoToolbox",
      );
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "app://streamy/api/v1/health",
      expect.anything(),
    );
  });

  it("follows the engine when it stops and comes back", async () => {
    await renderSection("Advanced");
    await waitFor(() => {
      expect(engineLine()).toHaveTextContent("Running");
    });

    act(() => {
      fakeStreamy.setEngineStatus({
        state: "restarting",
        error: "The playback engine stopped unexpectedly.",
      });
    });
    expect(engineLine()).toHaveTextContent("Reconnecting…");
    expect(
      screen.getByText("The playback engine stopped unexpectedly."),
    ).toBeInTheDocument();

    act(() => {
      fakeStreamy.setEngineStatus({
        state: "failed",
        error: "The library file can't be opened.",
      });
    });
    expect(engineLine()).toHaveTextContent(/not running/i);
    expect(
      screen.getByText("The library file can't be opened."),
    ).toBeInTheDocument();
  });

  it("names the CPU encoder, and says when ffmpeg doesn't work", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          ...HEALTH,
          ffmpeg: { version: null, error: "spawn ffmpeg ENOENT" },
          encoder: "libx264",
        }),
      ),
    );
    await renderSection("Advanced");

    await waitFor(() => {
      expect(engineLine()).toHaveTextContent(
        "Running · ffmpeg isn't working · CPU (x264)",
      );
    });
    // Never the raw system error, even if the engine sent one.
    expect(screen.queryByText("spawn ffmpeg ENOENT")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Videos that need converting won't play. The logs say why.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/ENOENT/)).not.toBeInTheDocument();
  });

  it("says what went wrong in plain words, even if told otherwise", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await renderSection("Advanced");

    act(() => {
      fakeStreamy.setEngineStatus({
        state: "failed",
        error: "Error: Cannot find module '/app/out/engine/index.js'",
      });
    });

    expect(engineLine()).toHaveTextContent(/not running/i);
    expect(
      screen.getByText("It keeps stopping. The logs say why."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Cannot find module/)).not.toBeInTheDocument();
  });

  it("stops asking the engine while the dialog is closed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = await renderSection("Advanced");
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });

      await user.click(screen.getByRole("button", { name: "Close settings" }));
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      const asked = fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(60_000));

      expect(fetchMock.mock.calls.length).toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't ask the engine anything while it isn't running", async () => {
    act(() => {
      fakeStreamy.setEngineStatus({ state: "starting", error: null });
    });
    await renderSection("Advanced");

    await waitFor(() => {
      expect(engineLine()).toHaveTextContent("Starting…");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the logs folder", async () => {
    const { user } = await renderSection("Advanced");
    api.openLogs.mockResolvedValueOnce({
      status: "error",
      message: "No app can open folders.",
    });

    await user.click(screen.getByRole("button", { name: "Open logs folder" }));

    expect(api.openLogs).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No app can open folders.",
    );
  });

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

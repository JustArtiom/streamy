import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Announcer } from "@/components/layout/announcer";
import { EngineBanner, SLOW_START_MS } from "@/components/layout/engine-banner";
import { HEALTH_INTERVAL_MS } from "@/hooks/use-health";
import { resetEngineStatusForTests } from "@/lib/engine-status";
import { useSettingsDialogOpen, useSettingsSection } from "@/lib/settings";
import { mockEngine } from "@/test/engine";
import { fakeStreamy } from "@/test/fake-streamy";
import { health } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

afterEach(() => {
  vi.useRealTimers();
});

function setStatus(state: "starting" | "running" | "restarting" | "failed") {
  act(() => {
    fakeStreamy.setEngineStatus({
      state,
      error: state === "failed" ? "It crashed" : null,
    });
  });
}

/** The banner, and the live region that says it (both in AppLayout). */
function renderBanner() {
  return renderWithProviders(
    <>
      <Announcer />
      <EngineBanner />
    </>,
  );
}

/** What screen readers are told: the app's live region. */
const announced = () => screen.getByRole("status");

describe("EngineBanner", () => {
  it("says nothing while all is well", async () => {
    const engine = mockEngine({ "GET /v1/health": health() });
    renderBanner();

    await waitFor(() => {
      expect(engine.callsTo("GET /v1/health")).toHaveLength(1);
    });
    expect(announced()).toBeEmptyDOMElement();
  });

  it("stays quiet during a normal launch, but not a slow one", () => {
    vi.useFakeTimers();
    mockEngine({ "GET /v1/health": health() });
    act(() => {
      resetEngineStatusForTests(); // the window just opened
    });
    setStatus("starting");
    renderBanner();

    act(() => {
      vi.advanceTimersByTime(SLOW_START_MS - 100);
    });
    expect(announced()).toBeEmptyDOMElement();

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(announced()).toHaveTextContent("Starting the playback engine…");

    setStatus("running");
    expect(announced()).toBeEmptyDOMElement();
  });

  it("says it's reconnecting as soon as the engine stops", () => {
    mockEngine({ "GET /v1/health": health() });
    renderBanner();

    setStatus("restarting");
    expect(announced()).toHaveTextContent(
      "Reconnecting to the playback engine…",
    );

    // Starting again after a crash isn't a normal launch.
    setStatus("starting");
    expect(announced()).toHaveTextContent(
      "Reconnecting to the playback engine…",
    );

    setStatus("running");
    expect(announced()).toBeEmptyDOMElement();
  });

  it("says when the engine keeps stopping, with a way to the logs", () => {
    mockEngine({ "GET /v1/health": health() });
    renderBanner();

    setStatus("failed");

    expect(announced()).toHaveTextContent(
      "The playback engine keeps stopping. Streamy will try again in a minute.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open logs" }));
    expect(fakeStreamy.api.openLogs).toHaveBeenCalledOnce();
  });

  it("warns when the disk is almost full, and links to Storage", async () => {
    mockEngine({ "GET /v1/health": health({ lowDiskSpace: true }) });
    renderBanner();

    await waitFor(() => {
      expect(announced()).toHaveTextContent(
        "Your disk is almost full. Downloading is paused; videos already downloaded still play.",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Storage settings" }));
    expect(readSettingsDialog()).toEqual({ open: true, section: "storage" });
  });

  it("is announced by a live region that was there before it", () => {
    mockEngine({ "GET /v1/health": health() });
    renderBanner();
    // Screen readers often miss a live region that comes with its text.
    const region = announced();
    expect(region).toBeEmptyDOMElement();

    setStatus("restarting");

    expect(announced()).toBe(region);
    expect(region).toHaveTextContent("Reconnecting to the playback engine…");
    // The banner itself isn't a second live region (no double reading).
    expect(screen.getAllByRole("status")).toHaveLength(1);

    setStatus("running");
    expect(region).toBeEmptyDOMElement();
  });

  it("asks the engine again every 30 seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const engine = mockEngine({ "GET /v1/health": health() });
    renderBanner();

    await waitFor(() => {
      expect(engine.callsTo("GET /v1/health")).toHaveLength(1);
    });
    engine.on("GET /v1/health", health({ lowDiskSpace: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
    });

    await waitFor(() => {
      expect(announced()).toHaveTextContent("Your disk is almost full.");
    });
    expect(engine.callsTo("GET /v1/health")).toHaveLength(2);
  });
});

/** The settings dialog's state, read through its own hooks. */
function readSettingsDialog() {
  let state: { open: boolean; section: string | null } | null = null;
  function Probe() {
    state = { open: useSettingsDialogOpen(), section: useSettingsSection() };
    return null;
  }
  renderWithProviders(<Probe />);
  return state;
}

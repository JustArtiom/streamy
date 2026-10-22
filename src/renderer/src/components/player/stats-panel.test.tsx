import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { EngineSnapshot } from "@/components/player/playback-engine";
import { StatsPanel } from "@/components/player/stats-panel";
import { torrentDetail } from "@/test/fixtures";
import { directPlayback, mediaInfo } from "@/test/player";

function snapshot(overrides: Partial<EngineSnapshot> = {}): EngineSnapshot {
  return {
    phase: "ready",
    session: directPlayback({
      mode: "transcode",
      reason: "Lower quality (480p) requested",
      encoder: "h264_videotoolbox",
      offset: 20,
    }),
    status: { state: "throttled", producedUntil: 140, error: null },
    producedUntil: 140,
    selection: { audioTrack: null, subtitleId: null, quality: "480p" },
    pendingSeek: null,
    playIntent: true,
    autoplayBlocked: false,
    error: null,
    forceMode: null,
    hlsPlayer: "hls.js",
    ...overrides,
  };
}

function renderPanel(value: EngineSnapshot) {
  render(
    <StatsPanel
      snapshot={value}
      media={mediaInfo()}
      torrent={torrentDetail({ peers: 12 })}
      videoRef={createRef()}
      getTime={() => 42}
      onClose={vi.fn()}
    />,
  );
}

describe("StatsPanel", () => {
  it("shows the mode, its reason and the encoder by its human name", () => {
    renderPanel(snapshot());

    expect(
      screen.getByText("transcode — Lower quality (480p) requested"),
    ).toBeVisible();
    expect(screen.getByText("VideoToolbox (graphics card)")).toBeVisible();
    expect(screen.getByText(/throttled/)).toBeVisible();
    expect(screen.getByText(/12 peers/)).toBeVisible();
  });

  it("says when nothing is encoded", () => {
    renderPanel(
      snapshot({
        session: directPlayback(),
        producedUntil: null,
        status: null,
      }),
    );

    expect(screen.getByText("None (plays the file itself)")).toBeVisible();
  });
});

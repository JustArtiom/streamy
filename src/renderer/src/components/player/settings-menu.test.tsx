import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MediaInfo } from "../../../../shared/engine-api";
import {
  SettingsMenu,
  type SettingsMenuProps,
} from "@/components/player/settings-menu";

const media: MediaInfo = {
  duration: 5400,
  container: "matroska,webm",
  bitRate: null,
  video: {
    codec: "hevc",
    profile: "Main 10",
    width: 1920,
    height: 1080,
    fps: 23.976,
    bitDepth: 10,
    hdr: false,
  },
  audioTracks: [
    {
      index: 0,
      codec: "ac3",
      channels: 6,
      language: "en",
      title: null,
      isDefault: true,
    },
    {
      index: 1,
      codec: "aac",
      channels: 2,
      language: "ru",
      title: "Dub",
      isDefault: false,
    },
  ],
  subtitleTracks: [
    {
      id: "embedded:0",
      source: "embedded",
      codec: "hdmv_pgs_subtitle",
      language: "en",
      title: null,
      isDefault: false,
      isForced: false,
      isText: false,
    },
    {
      id: "file:4",
      source: "file",
      codec: "subrip",
      language: "fr",
      title: "Movie.fr.srt",
      isDefault: false,
      isForced: false,
      isText: true,
    },
  ],
};

function setup(overrides: Partial<SettingsMenuProps> = {}) {
  const props: SettingsMenuProps = {
    onClose: vi.fn(),
    media,
    selection: { audioTrack: null, subtitleId: null, quality: "original" },
    onQuality: vi.fn(),
    onAudio: vi.fn(),
    onSubtitle: vi.fn(),
    subtitleLook: { size: "m", background: "shadow", color: "white" },
    onSubtitleLook: vi.fn(),
    subtitleDelay: 0,
    onSubtitleDelay: vi.fn(),
    rate: 1,
    onRate: vi.fn(),
    fit: "contain",
    onFit: vi.fn(),
    stats: false,
    onStats: vi.fn(),
    ...overrides,
  };
  render(<SettingsMenu {...props} />);
  return { props, user: userEvent.setup() };
}

describe("SettingsMenu", () => {
  it("sums up the current choices on the main panel", () => {
    setup();

    expect(screen.getByRole("menuitem", { name: /Quality/ })).toHaveTextContent(
      "Original (1080p)",
    );
    expect(screen.getByRole("menuitem", { name: /Audio/ })).toHaveTextContent(
      "English · 5.1",
    );
    expect(
      screen.getByRole("menuitem", { name: /Subtitles/ }),
    ).toHaveTextContent("Off");
    expect(screen.getByRole("menuitem", { name: /Speed/ })).toHaveTextContent(
      "Normal",
    );
  });

  it("offers the original plus lower qualities, with a CPU hint", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Quality/ }));
    const options = screen.getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Original (1080p)",
      expect.stringContaining("720p"),
      expect.stringContaining("480p"),
      expect.stringContaining("360p"),
    ]);
    expect(options[1]).toHaveTextContent("uses more CPU");

    await user.click(options[2] as HTMLElement);
    expect(props.onQuality).toHaveBeenCalledWith("480p");
    // A choice closes the menu (an open menu keeps the keyboard shortcuts).
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("describes audio tracks and switches to the one picked", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Audio/ }));
    expect(
      screen.getByRole("menuitemradio", { name: "English · 5.1 · AC3" }),
    ).toHaveAttribute("aria-checked", "true");

    await user.click(
      screen.getByRole("menuitemradio", { name: "Russian (Dub) · 2.0 · AAC" }),
    );
    expect(props.onAudio).toHaveBeenCalledWith(1);
  });

  it("lists every subtitle, marks picture ones as burned in, and turns them off", async () => {
    const { props, user } = setup({
      selection: {
        audioTrack: null,
        subtitleId: "file:4",
        quality: "original",
      },
    });

    await user.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    expect(
      screen.getByRole("menuitemradio", { name: /English.*burned in/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitemradio", { name: /French.*Movie\.fr\.srt/ }),
    ).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("menuitemradio", { name: "Off" }));
    expect(props.onSubtitle).toHaveBeenCalledWith(null);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("adjusts the subtitle delay in 0.1 s steps and resets it", async () => {
    const { props, user } = setup({ subtitleDelay: 0.3 });

    await user.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    await user.click(screen.getByRole("menuitem", { name: /Delay/ }));
    expect(screen.getByText("+0.3 s")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /Later/ }));
    expect(props.onSubtitleDelay).toHaveBeenLastCalledWith(0.4);
    await user.click(screen.getByRole("button", { name: /Earlier/ }));
    expect(props.onSubtitleDelay).toHaveBeenLastCalledWith(0.2);
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onSubtitleDelay).toHaveBeenLastCalledWith(0);
  });

  it("changes the subtitle style, one setting at a time", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Subtitles/ }));
    await user.click(screen.getByRole("menuitem", { name: /Style/ }));
    expect(screen.getByRole("radio", { name: "M" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: "XL" }));
    expect(props.onSubtitleLook).toHaveBeenLastCalledWith({ size: "xl" });
    await user.click(screen.getByRole("radio", { name: "Box" }));
    expect(props.onSubtitleLook).toHaveBeenLastCalledWith({
      background: "box",
    });
    await user.click(screen.getByRole("radio", { name: "Yellow" }));
    expect(props.onSubtitleLook).toHaveBeenLastCalledWith({ color: "yellow" });
    // Adjusting isn't a choice that closes the menu.
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("goes back from a sub-panel", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Speed/ }));
    expect(screen.queryByRole("menuitem", { name: /Quality/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: /Speed.*back/ }));
    expect(screen.getByRole("menuitem", { name: /Quality/ })).toBeVisible();
  });

  it("picks a speed and closes", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Speed/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "1.5×" }));
    expect(props.onRate).toHaveBeenCalledWith(1.5);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("picks a fit and closes", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Fit/ }));
    await user.click(screen.getByRole("menuitemradio", { name: /Fill/ }));
    expect(props.onFit).toHaveBeenCalledWith("fill");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("toggles stats without closing", async () => {
    const { props, user } = setup();

    await user.click(
      screen.getByRole("menuitemcheckbox", { name: /Stats for nerds/ }),
    );
    expect(props.onStats).toHaveBeenCalledWith(true);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and on a click outside, not on a click inside", async () => {
    const { props, user } = setup();

    await user.click(screen.getByRole("menuitem", { name: /Quality/ }));
    expect(props.onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);

    await user.click(document.body);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it("only offers speed, fit and stats without media info", () => {
    setup({ media: null });

    expect(screen.queryByRole("menuitem", { name: /Quality/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Subtitles/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Speed/ })).toBeVisible();
  });
});

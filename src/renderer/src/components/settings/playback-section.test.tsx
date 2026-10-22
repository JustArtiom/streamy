import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SUBTITLES_OFF } from "../../../../shared/settings";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { openSettings } from "@/lib/settings";
import { fakeStreamy, INITIAL_SNAPSHOT } from "@/test/fake-streamy";

const { api } = fakeStreamy;

async function renderPlayback() {
  const user = userEvent.setup();
  render(<SettingsDialog />);
  act(() => {
    openSettings();
  });
  await user.click(screen.getByRole("button", { name: "Playback" }));
  return user;
}

function changeSettings(patch: Partial<typeof INITIAL_SNAPSHOT.settings>) {
  act(() => {
    fakeStreamy.emit({
      ...INITIAL_SNAPSHOT,
      settings: { ...INITIAL_SNAPSHOT.settings, ...patch },
    });
  });
}

describe("Settings → Playback", () => {
  it("comes between Appearance and Storage", async () => {
    await renderPlayback();

    const sections = within(
      screen.getByRole("navigation", { name: "Settings sections" }),
    )
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(sections).toEqual([
      "General",
      "Appearance",
      "Playback",
      "Storage",
      "Network",
      "Advanced",
    ]);
  });

  it("picks an audio language, or Automatic", async () => {
    const user = await renderPlayback();
    const audio = screen.getByRole("combobox", { name: "Audio language" });
    expect(audio).toHaveDisplayValue("Automatic");

    await user.selectOptions(audio, "Japanese");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      audioLanguage: "ja",
    });

    await user.selectOptions(audio, "Automatic");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      audioLanguage: null,
    });
  });

  it("turns subtitles off, on for a language, or Automatic", async () => {
    const user = await renderPlayback();
    const subtitles = screen.getByRole("combobox", { name: "Subtitles" });
    expect(subtitles).toHaveDisplayValue("Automatic");

    await user.selectOptions(subtitles, "Off");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      subtitleLanguage: SUBTITLES_OFF,
    });
    expect(subtitles).toHaveDisplayValue("Off");

    await user.selectOptions(subtitles, "French");
    expect(api.settings.update).toHaveBeenLastCalledWith({
      subtitleLanguage: "fr",
    });
  });

  it("shows a language picked in the player even if it isn't listed", async () => {
    await renderPlayback();

    changeSettings({ audioLanguage: "pt-BR" });

    expect(
      screen.getByRole("combobox", { name: "Audio language" }),
    ).toHaveDisplayValue("Brazilian Portuguese");
  });

  it("changes the subtitle look, with a preview", async () => {
    const user = await renderPlayback();
    expect(
      screen.getByText("This is how subtitles will look."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "M" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "XL" }));
    await user.click(screen.getByRole("radio", { name: "Box" }));
    await user.click(screen.getByRole("radio", { name: "Yellow" }));

    expect(api.settings.update).toHaveBeenCalledWith({ subtitleSize: "xl" });
    expect(api.settings.update).toHaveBeenCalledWith({
      subtitleBackground: "box",
    });
    expect(api.settings.update).toHaveBeenCalledWith({
      subtitleColor: "yellow",
    });
    const line = screen.getByText("This is how subtitles will look.");
    expect(line).toHaveClass("bg-black/75");
    expect(line.parentElement).toHaveClass("text-yellow-300");
  });

  it("turns hardware video encoding off, and explains it", async () => {
    const user = await renderPlayback();
    const group = screen.getByRole("radiogroup", {
      name: "Hardware video encoding",
    });
    expect(
      within(group).getByRole("radio", { name: "Automatic" }),
    ).toBeChecked();
    expect(screen.getByText(/your graphics card does it faster/)).toBeVisible();

    await user.click(within(group).getByRole("radio", { name: "Off" }));

    expect(api.settings.update).toHaveBeenCalledWith({
      hardwareEncoding: "off",
    });
  });
});

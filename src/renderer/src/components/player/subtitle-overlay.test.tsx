import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Cue } from "../../../../shared/engine-api";
import {
  type SubtitleLook,
  SubtitleOverlay,
} from "@/components/player/subtitle-overlay";

const LOOK: SubtitleLook = { size: "m", background: "shadow", color: "white" };

function renderAt(time: number, cues: Cue[], delay = 0) {
  return render(
    <SubtitleOverlay
      cues={cues}
      getTime={() => time}
      delay={delay}
      look={LOOK}
      raised={false}
    />,
  );
}

describe("SubtitleOverlay", () => {
  it("shows the cue at the current movie time", async () => {
    renderAt(11, [
      { start: 1, end: 3, text: "Too early" },
      { start: 10, end: 12, text: "Right now" },
    ]);

    expect(await screen.findByText("Right now")).toBeVisible();
    expect(screen.queryByText("Too early")).toBeNull();
  });

  it("clears the line on screen when subtitles are turned off", async () => {
    const { rerender } = renderAt(11, [
      { start: 10, end: 12, text: "Right now" },
    ]);
    expect(await screen.findByText("Right now")).toBeVisible();

    // Turning subtitles off = the same overlay gets no cues.
    rerender(
      <SubtitleOverlay
        cues={[]}
        getTime={() => 11}
        delay={0}
        look={LOOK}
        raised={false}
      />,
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByText("Right now")).toBeNull();
  });

  it("follows the delay (positive = later)", async () => {
    renderAt(11, [{ start: 10, end: 12, text: "Hello" }], 2);

    // Shown from 12 s to 14 s now: nothing at 11 s.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("shows the delayed cue at its new time", async () => {
    renderAt(13, [{ start: 10, end: 12, text: "Hello" }], 2);

    expect(await screen.findByText("Hello")).toBeVisible();
  });

  it("renders <i>, <b>, <u> and line breaks as elements", async () => {
    renderAt(1, [
      { start: 0, end: 5, text: "<i>one</i>\n<b>two</b> <u>three</u>" },
    ]);

    const overlay = await screen.findByTestId("subtitles");
    expect(overlay.querySelector("i")).toHaveTextContent("one");
    expect(overlay.querySelector("b")).toHaveTextContent("two");
    expect(overlay.querySelector("u")).toHaveTextContent("three");
    expect(overlay.querySelectorAll("br")).toHaveLength(1);
  });

  it("never turns subtitle text into HTML", async () => {
    renderAt(1, [
      {
        start: 0,
        end: 5,
        text: '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      },
    ]);

    const overlay = await screen.findByTestId("subtitles");
    expect(overlay.querySelector("img")).toBeNull();
    expect(overlay.querySelector("script")).toBeNull();
    expect(overlay).toHaveTextContent(
      '<img src=x onerror="alert(1)"><script>alert(2)</script>',
    );
  });

  it("shows overlapping cues together", async () => {
    renderAt(2, [
      { start: 0, end: 5, text: "First" },
      { start: 1, end: 4, text: "Second" },
    ]);

    expect(await screen.findByText("First")).toBeVisible();
    expect(screen.getByText("Second")).toBeVisible();
  });

  it("looks like the Settings preview (the shared style classes)", async () => {
    render(
      <SubtitleOverlay
        cues={[{ start: 0, end: 5, text: "Styled" }]}
        getTime={() => 1}
        delay={0}
        look={{ size: "xl", background: "box", color: "yellow" }}
        raised={false}
      />,
    );

    const text = await screen.findByText("Styled");
    expect(text).toHaveClass("bg-black/75"); // box
    const line = text.closest("p");
    expect(line).toHaveClass("text-yellow-300");
    expect(line?.style.fontSize).toMatch(
      /clamp\(15px, 2.6vw, 34px\) \*\s?1.55/,
    );
  });

  it("renders nothing between cues", async () => {
    const { container } = renderAt(7, [{ start: 0, end: 5, text: "Gone" }]);

    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(container).toBeEmptyDOMElement();
  });
});

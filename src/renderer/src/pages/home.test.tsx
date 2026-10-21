import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { HomePage } from "@/pages/home";
import { fakeStreamy } from "@/test/fake-streamy";

const LINK = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10";

function renderHome() {
  const inputRef = createRef<HTMLInputElement>();
  render(<HomePage inputRef={inputRef} />);
  return screen.getByRole("textbox", { name: "Magnet link" });
}

describe("magnet links opened with Streamy", () => {
  it("fills in the link and focuses the input", () => {
    const input = renderHome();

    act(() => {
      fakeStreamy.openMagnetLink(LINK);
    });

    expect(input).toHaveValue(LINK);
    expect(input).toHaveFocus();
  });

  it("keeps a link that arrived before the page was shown", () => {
    fakeStreamy.openMagnetLink(LINK); // e.g. the link that launched the app

    expect(renderHome()).toHaveValue(LINK);
  });
});

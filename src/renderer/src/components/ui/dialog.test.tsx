import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogTitle } from "@/components/ui/dialog";

function renderDialog(dismissible: boolean) {
  const onClose = vi.fn();
  render(
    <Dialog open onClose={onClose} dismissible={dismissible} aria-label="Ask">
      <p>Sure?</p>
    </Dialog>,
  );
  const dialog = screen.getByRole("dialog", { name: "Ask" });
  return { dialog: dialog as HTMLDialogElement, onClose };
}

const escape = (dialog: HTMLElement) =>
  fireEvent(dialog, new Event("cancel", { cancelable: true }));

function clickBackdrop(dialog: HTMLElement) {
  fireEvent.pointerDown(dialog);
  fireEvent.pointerUp(dialog);
}

describe("Dialog", () => {
  it("closes with Esc and a click outside", () => {
    const { dialog, onClose } = renderDialog(true);

    expect(escape(dialog)).toBe(true);
    clickBackdrop(dialog);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open while it mustn't close (an action is running)", () => {
    const { dialog, onClose } = renderDialog(false);

    expect(escape(dialog)).toBe(false);
    clickBackdrop(dialog);
    // The browser's own close (a second Esc in a row) is undone.
    act(() => {
      dialog.close();
    });

    expect(dialog).toHaveAttribute("open");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("scrolls when it's taller than the window", () => {
    const { dialog } = renderDialog(true);
    // Its buttons must stay reachable in a small window.
    expect(dialog).toHaveClass("overflow-y-auto");
  });
});

describe("DialogTitle", () => {
  function renderTitle(text: string, clamped: boolean) {
    render(<DialogTitle>{text}</DialogTitle>);
    const heading = screen.getByRole("heading", { name: text });
    vi.spyOn(heading, "scrollHeight", "get").mockReturnValue(
      clamped ? 120 : 84,
    );
    vi.spyOn(heading, "clientHeight", "get").mockReturnValue(84);
    return heading;
  }

  it("wraps a long name anywhere, and stops after three lines", () => {
    const heading = renderTitle("Remove x?", false);
    expect(heading).toHaveClass("line-clamp-3", "[overflow-wrap:anywhere]");
  });

  it("has the whole text as a tooltip, only when it's cut", () => {
    const long = `Remove ${"Very.Long.Name.".repeat(15)}?`;
    const heading = renderTitle(long, true);

    fireEvent.pointerEnter(heading);

    expect(heading).toHaveAttribute("title", long);
  });

  it("has no tooltip when all of it shows", () => {
    const heading = renderTitle("Remove Sintel?", false);

    fireEvent.pointerEnter(heading);

    expect(heading).toHaveAttribute("title", "");
  });
});

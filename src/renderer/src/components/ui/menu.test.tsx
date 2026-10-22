import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "@/components/ui/menu";

function renderMenu() {
  const onRename = vi.fn();
  const onRemove = vi.fn();
  render(
    <>
      <button type="button">Before</button>
      <Menu label="More actions" trigger="⋯">
        <MenuItem onClick={onRename}>Rename</MenuItem>
        <MenuItem disabled>Share</MenuItem>
        <MenuItem tone="danger" onClick={onRemove}>
          Remove
        </MenuItem>
      </Menu>
    </>,
  );
  const button = screen.getByRole("button", { name: "More actions" });
  return { button, onRename, onRemove, user: userEvent.setup() };
}

describe("Menu", () => {
  it("opens on the first item and closes after a choice", async () => {
    const { button, onRemove, user } = renderMenu();
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "More actions" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.click(screen.getByRole("menuitem", { name: "Remove" }));

    expect(onRemove).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("moves with the arrow keys, skipping disabled items", async () => {
    const { button, onRemove, user } = renderMenu();
    button.focus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();

    await user.keyboard("{ArrowDown}"); // wraps around
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();

    await user.keyboard("{End}{Enter}");
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it("closes with Escape, back on its button", async () => {
    const { button, user } = renderMenu();

    await user.click(button);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("closes on a click outside", async () => {
    const { button, user } = renderMenu();

    await user.click(button);
    await user.click(screen.getByRole("button", { name: "Before" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});

describe("Menu near the edge of what's visible", () => {
  type Box = { top: number; left: number; width: number; height: number };

  function rect({ top, left, width, height }: Box): DOMRect {
    return {
      top,
      left,
      width,
      height,
      bottom: top + height,
      right: left + width,
      x: left,
      y: top,
      toJSON: () => ({}),
    };
  }

  /**
   * Fakes the layout jsdom doesn't have: the window, the trigger and where
   * the panel lands when it hangs below the trigger, right edges lined up.
   */
  function layOut(trigger: Box, panelSize = { width: 224, height: 96 }) {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(400);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(300);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        if (this.getAttribute("role") === "menu") {
          return rect({
            top: trigger.top + trigger.height + 8,
            left: trigger.left + trigger.width - panelSize.width,
            ...panelSize,
          });
        }
        if (this.tagName === "BUTTON") return rect(trigger);
        return rect({ top: 0, left: 0, width: 0, height: 0 });
      },
    );
  }

  it("moves into the window instead of sticking out of it", async () => {
    // Near the left edge: hanging from its right edge, it would go past x=0.
    layOut({ top: 20, left: 10, width: 28, height: 28 });
    const { button, user } = renderMenu();

    await user.click(button);

    const panel = screen.getByRole("menu");
    // 224 wide, ending at x=38: starts at -186, moved to x=8.
    expect(panel.style.translate).toBe("194px 0");
    expect(panel).toHaveClass("top-full");
  });

  it("opens upwards when there's no room below", async () => {
    layOut({ top: 250, left: 300, width: 28, height: 28 });
    const { button, user } = renderMenu();

    await user.click(button);

    const panel = screen.getByRole("menu");
    expect(panel).toHaveClass("bottom-full");
    expect(panel).not.toHaveClass("top-full");
    expect(panel.style.translate).toBe("");
  });
});

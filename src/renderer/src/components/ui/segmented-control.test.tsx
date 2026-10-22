import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "@/components/ui/segmented-control";

type Theme = "system" | "light" | "dark";

function renderThemes(initial: Theme = "light") {
  const onChange = vi.fn<(value: Theme) => void>();
  function Themes() {
    const [value, setValue] = useState<Theme>(initial);
    return (
      <>
        <button type="button">Before</button>
        <SegmentedControl
          label="Theme"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          options={[
            { value: "system", label: "System" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <button type="button">After</button>
      </>
    );
  }
  render(<Themes />);
  return { onChange, user: userEvent.setup() };
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("SegmentedControl", () => {
  it("is one Tab stop: the selected option", async () => {
    const { user } = renderThemes("light");

    await user.click(screen.getByRole("button", { name: "Before" }));
    await user.tab();
    expect(radio("Light")).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(radio("Light")).toHaveFocus();
  });

  it("moves and selects with the arrow keys, like radio buttons", async () => {
    const { onChange, user } = renderThemes("light");
    radio("Light").focus();

    await user.keyboard("{ArrowRight}");
    expect(radio("Dark")).toHaveFocus();
    expect(radio("Dark")).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith("dark");

    await user.keyboard("{ArrowRight}"); // wraps around
    expect(radio("System")).toHaveFocus();
    expect(radio("System")).toBeChecked();

    await user.keyboard("{ArrowLeft}");
    expect(radio("Dark")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(radio("Light")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(radio("Dark")).toHaveFocus();
  });

  it("jumps to the first and last with Home and End", async () => {
    const { onChange, user } = renderThemes("light");
    radio("Light").focus();

    await user.keyboard("{End}");
    expect(radio("Dark")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("dark");

    await user.keyboard("{Home}");
    expect(radio("System")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith("system");
  });

  it("leaves other keys alone", async () => {
    const { onChange, user } = renderThemes("light");
    radio("Light").focus();

    await user.keyboard("a");

    expect(onChange).not.toHaveBeenCalled();
    expect(radio("Light")).toHaveFocus();
  });
});

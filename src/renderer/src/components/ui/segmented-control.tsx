import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import type { KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

const groupVariants = cva(
  "inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5",
  {
    variants: {
      size: {
        sm: "h-9",
        md: "h-10",
      },
    },
    defaultVariants: { size: "md" },
  },
);

const itemVariants = cva(
  "inline-flex h-full items-center justify-center gap-1.5 rounded-[5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:shrink-0",
  {
    variants: {
      size: {
        sm: "px-2.5 text-sm [&_svg]:size-4",
        md: "px-3 text-sm [&_svg]:size-[18px]",
      },
      selected: {
        true: "bg-background text-foreground shadow-xs",
        false: "text-muted-foreground hover:text-foreground",
      },
      iconOnly: {
        true: "aspect-square px-0",
      },
    },
    defaultVariants: { size: "md", selected: false },
  },
);

type Option<T extends string> = {
  value: T;
  label: string;
  icon?: LucideIcon;
};

type SegmentedControlProps<T extends string> = VariantProps<
  typeof groupVariants
> & {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the whole group. */
  label: string;
  /** Show only icons (the label becomes the tooltip + screen-reader text). */
  iconOnly?: boolean;
  className?: string;
};

/**
 * Pick one of a few options (like a toggle with more than two states).
 * Keyboard, like radio buttons: the group is one Tab stop (the selected
 * option), and ←/→ (or ↑/↓), Home and End move and select.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  iconOnly = false,
  size,
  className,
}: SegmentedControlProps<T>) {
  // If the value isn't one of the options, the first one takes the Tab stop.
  const selectedIndex = options.findIndex((option) => option.value === value);
  const tabStop = selectedIndex === -1 ? 0 : selectedIndex;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = options.length - 1;
    // ← goes to the previous option in a left-to-right layout, and to the
    // next one in a right-to-left one.
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = rtl ? tabStop - 1 : tabStop + 1;
        break;
      case "ArrowDown":
        next = tabStop + 1;
        break;
      case "ArrowLeft":
        next = rtl ? tabStop + 1 : tabStop - 1;
        break;
      case "ArrowUp":
        next = tabStop - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    // Wraps around, like native radio buttons.
    const index = (next + options.length) % options.length;
    const option = options[index];
    if (!option) return;
    const buttons =
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    buttons[index]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(groupVariants({ size }), className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={iconOnly ? option.label : undefined}
          title={iconOnly ? option.label : undefined}
          // One Tab stop for the whole group; the arrows move inside it.
          tabIndex={index === tabStop ? 0 : -1}
          className={itemVariants({
            size,
            selected: option.value === value,
            iconOnly,
          })}
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.icon && <option.icon />}
          {!iconOnly && option.label}
        </button>
      ))}
    </div>
  );
}

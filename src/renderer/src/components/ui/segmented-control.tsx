import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
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
  "inline-flex h-full items-center justify-center gap-1.5 rounded-[5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 [&_svg]:shrink-0",
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

/** Pick one of a few options (like a toggle with more than two states). */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  iconOnly = false,
  size,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(groupVariants({ size }), className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={iconOnly ? option.label : undefined}
          title={iconOnly ? option.label : undefined}
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

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const spinnerVariants = cva(
  "inline-block shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent",
  {
    variants: {
      size: {
        sm: "size-3.5 border-[1.5px]",
        md: "size-4",
        lg: "size-6",
      },
      tone: {
        current: "text-current",
        muted: "text-muted-foreground",
      },
    },
    defaultVariants: { size: "md", tone: "current" },
  },
);

type SpinnerProps = ComponentProps<"span"> &
  VariantProps<typeof spinnerVariants> & {
    /** What's loading, for screen readers. */
    label?: string;
  };

/** A spinning ring. Its text color is its color. */
export function Spinner({
  className,
  size,
  tone,
  label = "Loading",
  ...props
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(spinnerVariants({ size, tone }), className)}
      {...props}
    />
  );
}

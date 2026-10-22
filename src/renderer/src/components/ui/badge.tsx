import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// `tone` picks a color into --badge, `appearance` decides how it's used.
// So every tone × appearance combination works without listing them all.
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "[--badge:var(--color-muted-foreground)]",
        info: "[--badge:var(--color-info)]",
        success: "[--badge:var(--color-success)]",
        warning: "[--badge:var(--color-warning)]",
        danger: "[--badge:var(--color-danger)]",
      },
      appearance: {
        soft: "border-transparent bg-(--badge)/12 text-(--badge)",
        solid: "border-transparent bg-(--badge) text-background",
        outline: "border-(--badge)/35 text-(--badge)",
      },
      size: {
        sm: "h-6 px-2.5 text-xs",
        md: "h-7 px-3 text-sm",
      },
      /** A small colored dot before the text (for statuses). */
      dot: {
        true: "before:size-1.5 before:rounded-full before:bg-current",
      },
    },
    defaultVariants: { tone: "neutral", appearance: "soft", size: "sm" },
  },
);

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

/** A short label: a status, a count, a tag. */
export function Badge({
  className,
  tone,
  appearance,
  size,
  dot,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(badgeVariants({ tone, appearance, size, dot }), className)}
      {...props}
    />
  );
}

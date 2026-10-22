import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const cardVariants = cva("rounded-lg", {
  variants: {
    variant: {
      default: "border border-border bg-background",
      muted: "border border-border bg-muted",
      dashed: "border border-dashed border-input bg-background",
      plain: "",
    },
    padding: {
      none: "",
      sm: "p-4",
      md: "p-5",
      lg: "p-6",
    },
  },
  defaultVariants: { variant: "default", padding: "md" },
});

type CardProps = ComponentProps<"div"> & VariantProps<typeof cardVariants>;

/** A bordered surface that groups related content. */
export function Card({ className, variant, padding, ...props }: CardProps) {
  return (
    <div
      className={cn(cardVariants({ variant, padding }), className)}
      {...props}
    />
  );
}

/**
 * The strip at the bottom of a card: a note on the left, a button on the
 * right. Use it with `<Card padding="none">`.
 */
export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted px-5 py-3",
        className,
      )}
      {...props}
    />
  );
}

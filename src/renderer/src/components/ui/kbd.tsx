import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const kbdVariants = cva(
  "inline-flex items-center justify-center rounded border border-border bg-muted font-sans font-medium text-muted-foreground",
  {
    variants: {
      size: {
        sm: "h-5 min-w-5 px-1 text-[11px]",
        md: "h-6 min-w-6 px-1.5 text-xs",
      },
    },
    defaultVariants: { size: "md" },
  },
);

type KbdProps = ComponentProps<"kbd"> & VariantProps<typeof kbdVariants>;

/** A keyboard key, e.g. <Kbd>⌘</Kbd><Kbd>K</Kbd>. */
export function Kbd({ className, size, ...props }: KbdProps) {
  return <kbd className={cn(kbdVariants({ size }), className)} {...props} />;
}

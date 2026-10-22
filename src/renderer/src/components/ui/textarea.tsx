import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Looks like Input. Invalid state is automatic: set aria-invalid.
const textareaVariants = cva(
  "w-full rounded-md border border-input bg-background text-foreground transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-muted-foreground/50 focus-visible:border-foreground/60 focus-visible:ring-3 focus-visible:ring-foreground/10 disabled:cursor-not-allowed disabled:bg-muted aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/15",
  {
    variants: {
      size: {
        sm: "min-h-20 px-3 py-2 text-sm",
        md: "min-h-28 px-3 py-2.5 text-sm",
        lg: "min-h-36 px-3.5 py-3 text-base",
      },
      resize: {
        none: "resize-none",
        vertical: "resize-y",
      },
      mono: {
        true: "font-mono",
      },
    },
    defaultVariants: { size: "md", resize: "vertical" },
  },
);

type TextareaProps = ComponentProps<"textarea"> &
  VariantProps<typeof textareaVariants>;

export function Textarea({
  className,
  size,
  resize,
  mono,
  ...props
}: TextareaProps) {
  return (
    <textarea
      className={cn(textareaVariants({ size, resize, mono }), className)}
      {...props}
    />
  );
}

import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// Invalid state is automatic: set aria-invalid and it turns red.
const inputVariants = cva(
  "w-full rounded-md border border-input bg-background text-foreground transition-[color,border-color,box-shadow] outline-none placeholder:text-muted-foreground hover:border-muted-foreground/50 focus-visible:border-foreground/60 focus-visible:ring-3 focus-visible:ring-foreground/10 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-danger aria-invalid:focus-visible:ring-danger/15",
  {
    variants: {
      size: {
        sm: "h-9 px-3 text-sm",
        md: "h-10 px-3 text-sm",
        lg: "h-11 px-3.5 text-base",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type InputProps = Omit<ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>;

export function Input({ className, size, ...props }: InputProps) {
  return (
    <input className={cn(inputVariants({ size }), className)} {...props} />
  );
}

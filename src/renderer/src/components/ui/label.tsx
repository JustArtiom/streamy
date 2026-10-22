import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const labelVariants = cva("font-medium text-foreground", {
  variants: {
    size: {
      sm: "text-xs",
      md: "text-sm",
    },
    required: {
      true: "after:ml-0.5 after:text-danger after:content-['*']",
    },
  },
  defaultVariants: { size: "md" },
});

type LabelProps = ComponentProps<"label"> & VariantProps<typeof labelVariants>;

export function Label({ className, size, required, ...props }: LabelProps) {
  return (
    <label
      className={cn(labelVariants({ size, required }), className)}
      {...props}
    />
  );
}

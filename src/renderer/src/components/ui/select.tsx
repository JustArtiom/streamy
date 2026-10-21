import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// The browser's own <select>, styled like Input: keyboard and mobile pickers
// keep working, we only swap the arrow for our icon.
const selectVariants = cva(
  "w-full appearance-none rounded-md border border-input bg-background pr-9 text-foreground transition-[color,border-color,box-shadow] outline-none hover:border-muted-foreground/50 focus-visible:border-foreground/60 focus-visible:ring-3 focus-visible:ring-foreground/10 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-danger",
  {
    variants: {
      size: {
        sm: "h-9 pl-3 text-sm",
        md: "h-10 pl-3 text-sm",
        lg: "h-11 pl-3.5 text-base",
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type SelectProps = Omit<ComponentProps<"select">, "size"> &
  VariantProps<typeof selectVariants>;

export function Select({ className, size, children, ...props }: SelectProps) {
  return (
    <div className="relative w-full">
      <select className={cn(selectVariants({ size }), className)} {...props}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

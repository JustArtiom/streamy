import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** A normal page's column: centered, with room around it. */
export function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-4xl flex-1 flex-col px-6 py-8",
        className,
      )}
      {...props}
    />
  );
}

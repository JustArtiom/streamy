import { Fragment } from "react";
import { cn } from "@/lib/cn";

/**
 * A file path that wraps at its slashes (/Users/sam/<wrap>Movies) instead of
 * in the middle of a folder name.
 */
export function PathText({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const parts = path.split(/(?<=[\\/])/);
  return (
    <span className={cn("font-mono wrap-anywhere select-text", className)}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

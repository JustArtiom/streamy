import { type ReactNode, useId } from "react";
import { cn } from "@/lib/cn";

type SettingRowProps = {
  title: string;
  description?: ReactNode;
  /** Put the control under the text (for wide controls) instead of beside it. */
  stacked?: boolean;
  /** Gets the ids of the title and description, to label its control. */
  children:
    | ReactNode
    | ((ids: { titleId: string; descriptionId: string }) => ReactNode);
};

/** One setting: its name and explanation, plus the control that changes it. */
export function SettingRow({
  title,
  description,
  stacked = false,
  children,
}: SettingRowProps) {
  const id = useId();
  const ids = { titleId: `${id}-title`, descriptionId: `${id}-description` };

  return (
    <div
      className={cn(
        // Divider above each row except the first (the last child of a
        // section may be something else, like a confirm dialog).
        "flex gap-x-6 gap-y-3 border-t border-border py-4 first:border-t-0 first:pt-0",
        // Side by side when there's room. In a small window (or at a big
        // interface size) the control wraps under the text instead of
        // squeezing it into a sliver.
        stacked ? "flex-col" : "flex-wrap items-center justify-between",
      )}
    >
      <div className={cn("min-w-0", !stacked && "min-w-48 flex-1")}>
        <p id={ids.titleId} className="text-sm font-medium">
          {title}
        </p>
        {description && (
          <div
            id={ids.descriptionId}
            className="mt-1 text-sm text-muted-foreground"
          >
            {description}
          </div>
        )}
      </div>
      <div className={cn(!stacked && "shrink-0")}>
        {typeof children === "function" ? children(ids) : children}
      </div>
    </div>
  );
}

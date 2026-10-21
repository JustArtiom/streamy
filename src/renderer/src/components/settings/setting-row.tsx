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
        stacked ? "flex-col" : "items-center justify-between",
      )}
    >
      <div className="min-w-0">
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

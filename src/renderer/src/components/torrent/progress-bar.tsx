import { cn } from "@/lib/cn";

/**
 * A thin bar for progress (0..1). Decorative by default: the number is
 * shown as text next to it. Pass `label` when it's the only way to tell.
 */
export function ProgressBar({
  value,
  label,
  tone = "auto",
  className,
}: {
  value: number;
  /** Makes it a real progressbar for screen readers, e.g. "Watched". */
  label?: string;
  /** "auto" turns green when complete (downloads); "neutral" never does. */
  tone?: "auto" | "neutral";
  className?: string;
}) {
  const percent = Math.min(100, Math.max(0, (value || 0) * 100));
  return (
    <div
      {...(label
        ? {
            role: "progressbar",
            "aria-label": label,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.floor(percent),
          }
        : { "aria-hidden": true })}
      className={cn(
        "h-1 w-full overflow-hidden rounded-full bg-accent",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          tone === "auto" && percent >= 100 ? "bg-success" : "bg-foreground/70",
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

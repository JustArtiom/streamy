import { CircleCheck, CircleX, Info, TriangleAlert, X } from "lucide-react";
import { Toaster as Sonner } from "sonner";
import { Spinner } from "@/components/ui/spinner";

/**
 * Where toasts appear. Mounted once in App.tsx; show one with
 * `toast("…")` from "@/lib/toast".
 *
 * Sonner handles the behavior (stacking, swipe to dismiss, pause on hover,
 * screen readers, Alt+T to reach them); the look is ours (`unstyled` + our
 * tokens).
 */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      gap={8}
      closeButton
      icons={{
        success: <CircleCheck />,
        error: <CircleX />,
        warning: <TriangleAlert />,
        info: <Info />,
        loading: <Spinner size="sm" tone="muted" />,
        close: <X />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group flex w-(--width) items-start gap-3 rounded-lg border border-border bg-background p-4 text-sm text-foreground shadow-lg shadow-black/5",
          // pr leaves room for the close button, which sits over this corner.
          // Reserved even while it's invisible, so text doesn't reflow on hover.
          content: "flex min-w-0 flex-1 flex-col gap-0.5 pr-5",
          title: "font-medium",
          description: "text-muted-foreground",
          icon: "mt-px flex shrink-0 [&_svg]:size-4",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-danger",
          warning: "[&_[data-icon]]:text-warning",
          info: "[&_[data-icon]]:text-info",
          actionButton:
            "h-7 shrink-0 self-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring",
          cancelButton:
            "h-7 shrink-0 self-center rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          // Shown on hover, and whenever the keyboard is inside the toast.
          closeButton:
            "absolute top-2 right-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity outline-none group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5",
        },
      }}
    />
  );
}

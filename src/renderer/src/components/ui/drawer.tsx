import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

// Built on the native <dialog>, like Dialog: Esc closes it, focus stays
// inside while it's open, and the page behind can't be clicked. It slides in
// using Tailwind's open:/starting: variants (no animation library needed).
const drawerVariants = cva(
  "fixed inset-y-0 m-0 h-dvh max-h-none max-w-[85vw] bg-background p-0 text-foreground outline-none transition-all transition-discrete duration-200 backdrop:bg-black/50 backdrop:transition-all backdrop:transition-discrete backdrop:duration-200 starting:open:backdrop:bg-transparent",
  {
    variants: {
      side: {
        left: "right-auto left-0 -translate-x-full border-r border-border open:translate-x-0 starting:open:-translate-x-full",
        right:
          "right-0 left-auto translate-x-full border-l border-border open:translate-x-0 starting:open:translate-x-full",
      },
      size: {
        sm: "w-72",
        md: "w-80",
        lg: "w-[26rem]",
      },
    },
    defaultVariants: { side: "left", size: "sm" },
  },
);

type DrawerProps = Omit<ComponentProps<"dialog">, "open"> &
  VariantProps<typeof drawerVariants> & {
    open: boolean;
    onClose: () => void;
  };

/** A panel that slides in from the side. Give it a name (aria-label). */
export function Drawer({
  open,
  onClose,
  side,
  size,
  className,
  children,
  ...props
}: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      // Esc key
      onClose={onClose}
      // Both ends of the press have to land on the backdrop: see Dialog for
      // why a plain click handler closes when you only meant to select text.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        const dismissed =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (dismissed) onClose();
      }}
      className={cn(drawerVariants({ side, size }), className)}
      {...props}
    >
      <div className="h-full">{children}</div>
    </dialog>
  );
}

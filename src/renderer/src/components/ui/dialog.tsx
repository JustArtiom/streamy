import { cva, type VariantProps } from "class-variance-authority";
import { type ComponentProps, type RefObject, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

// Built on the native <dialog>, like Drawer: Esc closes it, focus stays inside,
// and the page behind can't be clicked. Fades and scales in with open:/starting:.
const dialogVariants = cva(
  "m-auto max-h-[85dvh] w-[calc(100%-2rem)] overflow-hidden rounded-xl border border-border bg-background p-0 text-foreground opacity-0 outline-none shadow-2xl shadow-black/20 transition-all transition-discrete duration-150 backdrop:bg-black/50 backdrop:transition-all backdrop:transition-discrete backdrop:duration-150 open:scale-100 open:opacity-100 starting:open:scale-95 starting:open:opacity-0 starting:open:backdrop:bg-transparent",
  {
    variants: {
      size: {
        sm: "max-w-sm",
        md: "max-w-lg",
        lg: "max-w-2xl",
      },
      /** "top" keeps it high on the screen (search palettes); "center" for confirms. */
      position: {
        center: "",
        top: "mt-[12vh]",
      },
    },
    defaultVariants: { size: "md", position: "center" },
  },
);

type DialogProps = Omit<ComponentProps<"dialog">, "open"> &
  VariantProps<typeof dialogVariants> & {
    open: boolean;
    onClose: () => void;
    /** Element to focus when the dialog opens (e.g. a search input). */
    initialFocus?: RefObject<HTMLElement | null>;
  };

export function Dialog({
  open,
  onClose,
  initialFocus,
  size,
  position,
  className,
  children,
  ...props
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // React's autoFocus fires before showModal (while the dialog is still
      // hidden), so it does nothing. Focus after opening instead.
      initialFocus?.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open, initialFocus]);

  return (
    <dialog
      ref={ref}
      // Esc key
      onClose={onClose}
      // The dialog element itself is the dark backdrop; its content sits in a
      // child. Both ends of the press have to land on it, because `click`
      // fires on the nearest common ancestor — so selecting text and letting
      // go a few pixels outside would otherwise count as clicking the backdrop
      // and throw away whatever had been typed.
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerUp={(event) => {
        const dismissed =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (dismissed) onClose();
      }}
      className={cn(dialogVariants({ size, position }), className)}
      {...props}
    >
      {children}
    </dialog>
  );
}

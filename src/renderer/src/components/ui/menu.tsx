import { cva, type VariantProps } from "class-variance-authority";
import {
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/cn";

// It hangs from the trigger's own edge, so put the trigger near the edge it
// opens towards. If it would still stick out of what's visible (a narrow
// window, a trigger near the bottom of a scrolling page), it moves sideways
// and opens on the other side: see fitPanel.
const panelVariants = cva(
  "absolute z-40 w-56 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background p-1 text-foreground shadow-lg shadow-black/10 transition-all duration-100 starting:scale-95 starting:opacity-0",
  {
    variants: {
      align: {
        start: "left-0",
        end: "right-0",
      },
      /** "top" for triggers near the bottom of the window (player controls). */
      side: {
        bottom: "top-full mt-2",
        top: "bottom-full mb-2",
      },
    },
    compoundVariants: [
      { align: "start", side: "bottom", className: "origin-top-left" },
      { align: "end", side: "bottom", className: "origin-top-right" },
      { align: "start", side: "top", className: "origin-bottom-left" },
      { align: "end", side: "top", className: "origin-bottom-right" },
    ],
    defaultVariants: { align: "end", side: "bottom" },
  },
);

type MenuProps = VariantProps<typeof panelVariants> & {
  /** What the button shows (usually an icon). */
  trigger: ReactNode;
  /** The button's accessible name, e.g. "More actions for Sintel". */
  label: string;
  triggerClassName?: string;
  className?: string;
  children: ReactNode;
};

type Side = "top" | "bottom";

/** How the open panel is moved to stay in view. */
type Fit = { side: Side | null; shift: number };
const AS_ASKED: Fit = { side: null, shift: 0 };

/** Room kept between the panel and the edge of what's visible. */
const EDGE = 8;

/**
 * The part of the window `element` can be seen in: the window, cut down by
 * every scrolling or clipping ancestor (e.g. <main>, which scrolls).
 */
function visibleArea(element: HTMLElement) {
  let top = 0;
  let left = 0;
  let bottom = window.innerHeight;
  let right = window.innerWidth;
  for (
    let ancestor = element.parentElement;
    ancestor && ancestor !== document.body;
    ancestor = ancestor.parentElement
  ) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === "visible" && style.overflowY === "visible") {
      continue;
    }
    const rect = ancestor.getBoundingClientRect();
    top = Math.max(top, rect.top);
    left = Math.max(left, rect.left);
    bottom = Math.min(bottom, rect.bottom);
    right = Math.min(right, rect.right);
  }
  return { top, left, bottom, right };
}

/**
 * Where the panel is, without its opening animation (it starts at 95%
 * scale, which getBoundingClientRect includes): its layout box, placed by
 * the menu's root (its offsetParent).
 */
function panelBox(panel: HTMLElement) {
  const parent = panel.offsetParent;
  if (!parent) return panel.getBoundingClientRect();
  const origin = parent.getBoundingClientRect();
  const left = origin.left + panel.offsetLeft;
  const top = origin.top + panel.offsetTop;
  return {
    left,
    top,
    right: left + panel.offsetWidth,
    bottom: top + panel.offsetHeight,
    width: panel.offsetWidth,
    height: panel.offsetHeight,
  };
}

/**
 * Where the panel should go so all of it can be seen: shifted sideways into
 * view, and on the other side of the trigger if it doesn't fit below (or
 * above) and there's more room there.
 */
function fitPanel(panel: HTMLElement, trigger: HTMLElement, side: Side): Fit {
  const rect = panelBox(panel);
  // Not laid out (e.g. tests without a real layout): leave it be.
  if (rect.width === 0 && rect.height === 0) return AS_ASKED;
  const area = visibleArea(panel);
  const around = trigger.getBoundingClientRect();

  let shift = 0;
  if (rect.left < area.left + EDGE) {
    shift = area.left + EDGE - rect.left;
  } else if (rect.right > area.right - EDGE) {
    shift = area.right - EDGE - rect.right;
  }

  const roomAbove = around.top - area.top;
  const roomBelow = area.bottom - around.bottom;
  let fitSide: Side | null = null;
  if (side === "bottom" && rect.bottom > area.bottom - EDGE) {
    if (roomAbove > roomBelow) fitSide = "top";
  } else if (side === "top" && rect.top < area.top + EDGE) {
    if (roomBelow > roomAbove) fitSide = "bottom";
  }
  return { side: fitSide, shift };
}

function menuItems(panel: HTMLElement | null) {
  return Array.from(
    panel?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ??
      [],
  );
}

/**
 * A dropdown menu. Keyboard: Enter/Space/↓ open it on the first item, ↑/↓
 * move, Home/End jump, Esc closes (back to the button), Tab leaves. Closes
 * on a click outside and after picking an item.
 */
export function Menu({
  trigger,
  label,
  align,
  side,
  triggerClassName,
  className,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState<Fit>(AS_ASKED);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const askedSide: Side = side ?? "bottom";

  // Measured before the first paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    if (!open || !panel.current || !button.current) return;
    setFit(fitPanel(panel.current, button.current, askedSide));
    return () => {
      setFit(AS_ASKED);
    };
  }, [open, askedSide]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };

  // Focus the first item when it opens, so the keys work right away.
  useEffect(() => {
    if (open) menuItems(panel.current)[0]?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const onPanelKeyDown = (event: KeyboardEvent) => {
    const items = menuItems(panel.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => {
      items[(next + items.length) % items.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
      case "Escape":
        // Don't let Esc also close a dialog or the player behind the menu.
        event.stopPropagation();
        close(true);
        break;
      case "Tab":
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    // While open, above whatever comes later in the page (e.g. the next
    // card's own menu button).
    <div ref={root} className={cn("relative", className, open && "z-50")}>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => {
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
          triggerClassName,
        )}
      >
        {trigger}
      </button>

      {open && (
        <div
          ref={panel}
          id={panelId}
          role="menu"
          aria-label={label}
          className={panelVariants({ align, side: fit.side ?? askedSide })}
          style={fit.shift ? { translate: `${fit.shift}px 0` } : undefined}
          onKeyDown={onPanelKeyDown}
          // Anything clicked inside is a choice, so the menu closes after it.
          onClick={() => {
            close(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** A row you can pick. `tone="danger"` for destructive actions. */
export function MenuItem({
  className,
  tone,
  ...props
}: ComponentProps<"button"> & { tone?: "danger" }) {
  return (
    <button
      type="button"
      role="menuitem"
      // Arrow keys move between items; Tab leaves the menu.
      tabIndex={-1}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        tone === "danger"
          ? "text-danger [&_svg]:text-danger"
          : "text-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** Non-clickable content (a heading, a note). */
export function MenuSection({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-3 py-2", className)} {...props} />;
}

export function MenuSeparator() {
  return <div role="separator" className="my-1 h-px bg-border" />;
}

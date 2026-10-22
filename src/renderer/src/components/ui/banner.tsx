import { cva, type VariantProps } from "class-variance-authority";
import {
  CircleX,
  Info,
  type LucideIcon,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { Spinner } from "@/components/ui/spinner";
import { announce } from "@/lib/announcer";
import { cn } from "@/lib/cn";

// A full-width strip under the title bar, for news about the whole app
// (the engine restarting, the disk being full). Quiet on purpose: a tinted
// background and one line of text, with at most a button or two.
const bannerVariants = cva(
  "flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-(--banner)/25 bg-(--banner)/8 px-4 py-2 text-sm",
  {
    variants: {
      tone: {
        info: "[--banner:var(--color-info)]",
        warning: "[--banner:var(--color-warning)]",
        danger: "[--banner:var(--color-danger)]",
        privacy: "[--banner:var(--color-info)]",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

type Tone = NonNullable<VariantProps<typeof bannerVariants>["tone"]>;

const ICONS: Record<Tone, LucideIcon> = {
  info: Info,
  warning: TriangleAlert,
  danger: CircleX,
  privacy: ShieldCheck,
};

type BannerProps = VariantProps<typeof bannerVariants> & {
  /** Shows a spinner instead of the icon (something is in progress). */
  busy?: boolean;
  /** The short version, in bold. */
  title: ReactNode;
  /** One more sentence, if needed. */
  children?: ReactNode;
  /** Buttons at the end. */
  actions?: ReactNode;
  className?: string;
};

export function Banner({
  tone = "info",
  busy = false,
  title,
  children,
  actions,
  className,
}: BannerProps) {
  const Icon = ICONS[tone ?? "info"];
  const id = useId();
  const text = useRef<HTMLParagraphElement>(null);

  // Announced politely (it's news, not an interruption) through the app's
  // live region: one that's always there gets heard, a new one often not.
  useEffect(() => {
    announce(id, text.current?.textContent ?? null);
  });
  useEffect(
    () => () => {
      announce(id, null);
    },
    [id],
  );

  return (
    <div className={cn(bannerVariants({ tone }), className)}>
      <span className="flex size-4 shrink-0 items-center justify-center text-(--banner)">
        {busy ? (
          <Spinner size="sm" aria-hidden />
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </span>
      <p ref={text} className="min-w-0 flex-1">
        <span className="font-medium">{title}</span>
        {children && <span className="text-muted-foreground"> {children}</span>}
      </p>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

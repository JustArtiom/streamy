import { cva, type VariantProps } from "class-variance-authority";
import {
  CircleCheck,
  CircleX,
  Info,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

// `tone` picks a color into --alert; border, background and icon use it.
const alertVariants = cva(
  "flex gap-3 rounded-md border border-(--alert)/30 bg-(--alert)/6 p-3 text-sm",
  {
    variants: {
      tone: {
        info: "[--alert:var(--color-info)]",
        success: "[--alert:var(--color-success)]",
        warning: "[--alert:var(--color-warning)]",
        danger: "[--alert:var(--color-danger)]",
      },
    },
    defaultVariants: { tone: "info" },
  },
);

type Tone = NonNullable<VariantProps<typeof alertVariants>["tone"]>;

const ICONS: Record<Tone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX,
};

type AlertProps = Omit<ComponentProps<"div">, "title"> &
  VariantProps<typeof alertVariants> & {
    title?: ReactNode;
  };

/** A message inside the page: what happened, and what to do about it. */
export function Alert({
  className,
  tone = "info",
  title,
  children,
  ...props
}: AlertProps) {
  const Icon = ICONS[tone ?? "info"];

  return (
    <div
      // danger/warning interrupt screen readers; info/success are polite
      role={tone === "danger" || tone === "warning" ? "alert" : "status"}
      className={cn(alertVariants({ tone }), className)}
      {...props}
    >
      <Icon className="mt-px size-4 shrink-0 text-(--alert)" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        {title && <p className="font-medium text-foreground">{title}</p>}
        {children && <div className="text-muted-foreground">{children}</div>}
      </div>
    </div>
  );
}

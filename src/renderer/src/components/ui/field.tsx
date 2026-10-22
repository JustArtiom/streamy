import { cva } from "class-variance-authority";
import { useId } from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/cn";

const messageVariants = cva("", {
  variants: {
    tone: {
      hint: "text-muted-foreground",
      error: "text-danger",
    },
    size: {
      sm: "text-xs",
      md: "text-sm",
      lg: "text-sm",
    },
  },
});

type FieldProps = InputProps & {
  label: string;
  /** Keep the label for screen readers only (the page already says it). */
  hideLabel?: boolean;
  /** Small help text under the input (hidden while there's an error). */
  hint?: string;
  error?: string;
};

/** Label + Input + hint/error, wired together for screen readers. */
export function Field({
  label,
  hideLabel = false,
  hint,
  error,
  size = "md",
  required,
  className,
  id: idProp,
  ...props
}: FieldProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label
        htmlFor={id}
        size={size === "sm" ? "sm" : "md"}
        required={required}
        className={cn(hideLabel && "sr-only")}
      >
        {label}
      </Label>
      <Input
        id={id}
        size={size}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={message ? messageId : undefined}
        {...props}
      />
      {message && (
        <p
          id={messageId}
          // Errors are announced as soon as they appear.
          role={error ? "alert" : undefined}
          className={messageVariants({ tone: error ? "error" : "hint", size })}
        >
          {message}
        </p>
      )}
    </div>
  );
}

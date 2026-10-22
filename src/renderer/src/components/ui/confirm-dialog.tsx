import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";

/**
 * "Are you sure?" for an action that can't be undone. When the action fails,
 * pass `error` and the dialog stays open showing why.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** Put a torrent's name in <bdi>, so a right-to-left one stays whole. */
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  /**
   * While the action runs: the buttons are disabled, and Esc or a click
   * outside doesn't close it (its result would be lost).
   */
  busy?: boolean;
  /** Why the last attempt failed. */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const titleId = useId();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="sm"
      aria-labelledby={titleId}
    >
      <div className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-1">
          <DialogTitle id={titleId}>{title}</DialogTitle>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

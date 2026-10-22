import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { useRemoveTorrent } from "@/hooks/use-torrents";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { toast } from "@/lib/toast";

export type RemoveTarget = { infoHash: string; name: string | null };

type Choice = "data" | "forget";

const CHOICES: { value: Choice; title: string; description: string }[] = [
  {
    value: "data",
    title: "Delete the downloaded video",
    description:
      "Frees up space. It stays in Recent, and downloads again if you watch it later.",
  },
  {
    value: "forget",
    title: "Remove it from Streamy",
    description:
      "Also forgets it: it leaves Recent and Continue watching, with its saved positions.",
  },
];

/**
 * "Remove <name>?" with two choices: delete only the downloaded data, or
 * forget the torrent completely. `target` null = closed.
 */
export function RemoveTorrentDialog({
  target,
  onClose,
  onRemoved,
}: {
  target: RemoveTarget | null;
  onClose: () => void;
  /** After it worked (the torrent page goes Home). */
  onRemoved?: () => void;
}) {
  const remove = useRemoveTorrent();
  const [choice, setChoice] = useState<Choice>("data");
  const titleId = useId();

  const close = () => {
    remove.reset();
    setChoice("data");
    onClose();
  };

  const confirm = () => {
    if (!target) return;
    const forget = choice === "forget";
    remove.mutate(
      { infoHash: target.infoHash, forget },
      {
        onSuccess: () => {
          const label = target.name ? <bdi>{target.name}</bdi> : "the torrent";
          toast.success(
            forget ? (
              <>Removed {label} from Streamy</>
            ) : (
              <>Deleted the downloaded video of {label}</>
            ),
          );
          close();
          onRemoved?.();
        },
      },
    );
  };

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      // Closing mid-request would lose what follows it (the toast, going Home).
      dismissible={!remove.isPending}
      size="sm"
      aria-labelledby={titleId}
    >
      <form
        className="flex flex-col gap-5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <DialogTitle id={titleId}>
          Remove {target?.name ? <bdi>{target.name}</bdi> : "this torrent"}?
        </DialogTitle>

        <fieldset className="flex flex-col gap-2" disabled={remove.isPending}>
          <legend className="sr-only">What to remove</legend>
          {CHOICES.map((item) => (
            <label
              key={item.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-muted has-checked:border-foreground/40 has-checked:bg-accent has-focus-visible:ring-2 has-focus-visible:ring-ring",
              )}
            >
              <input
                type="radio"
                name="remove-choice"
                value={item.value}
                checked={choice === item.value}
                onChange={() => {
                  setChoice(item.value);
                }}
                className="mt-0.5 size-4 shrink-0 accent-foreground outline-none"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{item.title}</span>
                <span className="text-sm text-muted-foreground">
                  {item.description}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {remove.error && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(remove.error)}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={remove.isPending}>
            {choice === "forget" ? "Remove" : "Delete video"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

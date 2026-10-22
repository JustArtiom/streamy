import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SINTEL_MAGNET, useAddAndOpen } from "@/hooks/use-add-and-open";
import { toast } from "@/lib/toast";

/** Nothing watched or opened yet. Offers a legal movie to try it with. */
export function EmptyState() {
  const { addAndOpen, isPending } = useAddAndOpen();

  return (
    <Card
      variant="dashed"
      className="flex flex-col items-center gap-3 px-6 py-10 text-center"
    >
      <span className="flex size-11 items-center justify-center rounded-full bg-accent text-muted-foreground">
        <Clapperboard className="size-5" aria-hidden />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">Nothing here yet</p>
        <p className="text-sm text-balance text-muted-foreground">
          What you watch shows up here, so you can pick up where you left off.
        </p>
      </div>
      <p className="text-sm text-balance text-muted-foreground">
        No magnet handy?{" "}
        <Button
          variant="link"
          // The size variant's height and padding would win over "link".
          className="h-auto px-0 align-baseline text-sm"
          loading={isPending}
          onClick={() => {
            void addAndOpen({ kind: "magnet", magnet: SINTEL_MAGNET }).then(
              (problem) => {
                if (problem) {
                  toast.error("Couldn't open Sintel", { description: problem });
                }
              },
            );
          }}
        >
          Try Sintel
        </Button>
        , an open movie by the Blender Foundation.
      </p>
    </Card>
  );
}

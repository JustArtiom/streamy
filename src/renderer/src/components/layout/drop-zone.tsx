import { FileUp } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useAddAndOpen } from "@/hooks/use-add-and-open";
import { isTorrentFile } from "@/lib/magnet";
import { toast } from "@/lib/toast";

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/**
 * Drop a .torrent anywhere on the window to open it. Shows an overlay while
 * a file is dragged over. Without this, Electron would try to open the file
 * itself (the main process blocks that, but the page must still say no).
 */
export function DropZone() {
  const { addAndOpen } = useAddAndOpen();
  const [dragging, setDragging] = useState(false);

  const onDropFiles = useEffectEvent((files: File[]) => {
    const file = files.find(isTorrentFile);
    if (!file) {
      const name = files[0]?.name;
      // Names in <bdi>: a right-to-left one stays whole in the sentence.
      toast.error(
        name ? (
          <>
            "<bdi>{name}</bdi>" isn't a .torrent file
          </>
        ) : (
          "That isn't a .torrent file"
        ),
        { description: "Streamy opens .torrent files and magnet links." },
      );
      return;
    }
    const name = <bdi>{file.name}</bdi>;
    const id = toast.loading(<>Opening {name}…</>);
    void addAndOpen({ kind: "file", file }).then((problem) => {
      if (problem) {
        toast.error(<>Couldn't open {name}</>, {
          id,
          description: problem,
        });
      } else {
        toast.dismiss(id);
      }
    });
  });

  useEffect(() => {
    // dragenter/dragleave fire for every element crossed; counting them
    // tells when the drag really left the window.
    let depth = 0;

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Without this the drop goes to the browser, which opens the file.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onDropFiles(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  if (!dragging) return null;

  return (
    <div
      data-testid="drop-overlay"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border-2 border-dashed border-foreground/30 bg-background px-6 py-12 text-center shadow-2xl shadow-black/10">
        <span className="flex size-12 items-center justify-center rounded-full bg-accent">
          <FileUp className="size-6" aria-hidden />
        </span>
        <p className="font-medium">Drop the .torrent to open it</p>
        <p className="text-sm text-muted-foreground">
          It starts playing while it downloads.
        </p>
      </div>
    </div>
  );
}

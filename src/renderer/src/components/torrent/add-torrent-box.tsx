import { FolderOpen, Play } from "lucide-react";
import {
  type ClipboardEvent,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { useAddAndOpen } from "@/hooks/use-add-and-open";
import { checkMagnetInput, isTorrentFile, looksLikeMagnet } from "@/lib/magnet";
import { isMac, isModKey } from "@/lib/platform";

/**
 * The way in: paste a magnet link or info hash, or pick a .torrent file.
 * (Dropping a .torrent works anywhere in the window: see DropZone.)
 * ⌘K / Ctrl+K jumps here.
 */
export function AddTorrentBox() {
  const { addAndOpen, pendingInput } = useAddAndOpen();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses the box.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isModKey(event) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const addMagnet = (magnet: string) => {
    const problem = checkMagnetInput(magnet);
    if (problem) {
      setError(problem);
      return;
    }
    setError(undefined);
    void addAndOpen({ kind: "magnet", magnet: magnet.trim() }).then(
      (message) => {
        if (message) setError(message);
      },
    );
  };

  const addFile = (file: File) => {
    if (!isTorrentFile(file)) {
      setError(`"${file.name}" isn't a .torrent file`);
      return;
    }
    setError(undefined);
    void addAndOpen({ kind: "file", file }).then((message) => {
      if (message) setError(message);
    });
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    addMagnet(value);
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    // A whole magnet pasted = they want to watch it. Skip the click.
    const text = event.clipboardData.getData("text/plain");
    if (!looksLikeMagnet(text) || pendingInput) return;
    event.preventDefault();
    setValue(text.trim());
    addMagnet(text);
  };

  const addingMagnet = pendingInput?.kind === "magnet";
  const addingFile = pendingInput?.kind === "file";

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="flex w-full flex-col items-center gap-3"
    >
      <div className="flex w-full items-start gap-2">
        <Field
          ref={input}
          label="Magnet link or info hash"
          hideLabel
          size="lg"
          className="flex-1 text-left"
          placeholder="magnet:?xt=urn:btih:…"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={value}
          error={error}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          onPaste={onPaste}
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        />
        <Button
          type="submit"
          size="lg"
          loading={addingMagnet}
          disabled={addingFile}
        >
          {!addingMagnet && <Play className="fill-current" aria-hidden />}
          Play
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <Button
          variant="ghost"
          size="sm"
          loading={addingFile}
          disabled={addingMagnet}
          onClick={() => fileInput.current?.click()}
        >
          {!addingFile && <FolderOpen aria-hidden />}
          Open a .torrent file
        </Button>
        <span>or drop one anywhere</span>
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".torrent,application/x-bittorrent"
        className="hidden"
        aria-label="Choose a .torrent file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset, so picking the same file again still fires onChange.
          event.target.value = "";
          if (file) addFile(file);
        }}
      />
    </form>
  );
}

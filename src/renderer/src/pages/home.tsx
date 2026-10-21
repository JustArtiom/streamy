import { FolderOpen, History, Play } from "lucide-react";
import { type RefObject, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { onMagnetLinkOpened } from "@/lib/incoming-links";

type HomePageProps = {
  /** Lets ⌘K / Ctrl+K focus the magnet input. */
  inputRef: RefObject<HTMLInputElement | null>;
};

export function HomePage({ inputRef }: HomePageProps) {
  const [magnet, setMagnet] = useState("");

  // A magnet link clicked in a browser (with Streamy as the magnet app).
  useEffect(
    () =>
      onMagnetLinkOpened((link) => {
        setMagnet(link);
        inputRef.current?.focus();
      }),
    [inputRef],
  );

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-12 px-6 pt-20 pb-10">
      <section className="flex flex-col items-center gap-7 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            What do you want to watch?
          </h1>
          <p className="text-muted-foreground">
            Paste a magnet link or open a .torrent file. Streamy starts playing
            while it downloads.
          </p>
        </div>

        {/* Demo only: nothing is played yet. */}
        <form
          className="flex w-full gap-2"
          onSubmit={(event) => {
            event.preventDefault();
          }}
        >
          <Input
            ref={inputRef}
            size="lg"
            value={magnet}
            onChange={(event) => {
              setMagnet(event.target.value);
            }}
            placeholder="magnet:?xt=urn:btih:…"
            aria-label="Magnet link"
            spellCheck={false}
            autoComplete="off"
          />
          <Button type="submit" size="lg" disabled={!magnet.trim()}>
            <Play />
            Play
          </Button>
        </form>

        <Button variant="ghost" size="sm">
          <FolderOpen />
          Open a .torrent file
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Continue watching</h2>
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <History className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing here yet</p>
          <p className="text-sm text-muted-foreground">
            Videos you start watching will show up here.
          </p>
        </div>
      </section>
    </div>
  );
}

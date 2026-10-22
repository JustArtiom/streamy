import { TriangleAlert } from "lucide-react";
import { useRouteError } from "react-router";
import { TitleBar } from "@/components/title-bar";
import { Button } from "@/components/ui/button";

/**
 * A page crashed (a bug). Keeps the title bar, so the window can still be
 * moved, and offers a way out.
 */
export function RouteError() {
  const error = useRouteError();
  console.error("A page crashed:", error);

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar />
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-accent text-muted-foreground">
          <TriangleAlert className="size-6" aria-hidden />
        </span>
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-balance text-muted-foreground">
            This page stopped working. Going back to the start usually helps.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            // A full reload: whatever broke starts over.
            window.location.assign("/");
          }}
        >
          Back to the start
        </Button>
      </main>
    </div>
  );
}

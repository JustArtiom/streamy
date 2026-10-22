import { ContinueWatching } from "@/components/home/continue-watching";
import { EmptyState } from "@/components/home/empty-state";
import { RecentList } from "@/components/home/recent-list";
import { Page } from "@/components/layout/page";
import { AddTorrentBox } from "@/components/torrent/add-torrent-box";
import { VersionFooter } from "@/components/version-footer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useLibrary } from "@/hooks/use-library";
import { errorMessage } from "@/lib/api";

export function HomePage() {
  useDocumentTitle(null);

  return (
    <>
      <Page className="gap-12 pt-16">
        <section className="mx-auto flex w-full max-w-2xl flex-col items-center gap-7 text-center">
          <div className="flex flex-col gap-2">
            <h1 className="text-3xl font-semibold tracking-tight">
              What do you want to watch?
            </h1>
            <p className="text-muted-foreground">
              Paste a magnet link or open a .torrent file. Streamy starts
              playing while it downloads.
            </p>
          </div>
          <AddTorrentBox />
        </section>

        <Library />
      </Page>
      <VersionFooter />
    </>
  );
}

/** Continue watching and Recent, or a first-run hint when both are empty. */
function Library() {
  const library = useLibrary();

  if (library.isPending) {
    // Paused = waiting for the engine to start (the banner says why).
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner size="sm" />
        {library.fetchStatus === "paused"
          ? "Waiting for the playback engine…"
          : "Loading your library…"}
      </div>
    );
  }

  // No data after loading = it failed (a failed refresh keeps the old data).
  if (library.data === undefined) {
    return (
      <Alert tone="danger" title="Couldn't load your library">
        <div className="flex flex-col items-start gap-2">
          {errorMessage(library.error)}
          <Button
            variant="outline"
            size="sm"
            loading={library.isFetching}
            onClick={() => void library.refetch()}
          >
            Try again
          </Button>
        </div>
      </Alert>
    );
  }

  const { continueWatching, recent } = library.data;
  if (continueWatching.length === 0 && recent.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className="flex flex-col gap-10">
      <ContinueWatching items={continueWatching} />
      <RecentList torrents={recent} />
    </div>
  );
}

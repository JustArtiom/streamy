import {
  ArrowDown,
  ArrowUp,
  CloudOff,
  FileX,
  HardDrive,
  type LucideIcon,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import type { TorrentDetail } from "../../../shared/engine-api";
import { Page } from "@/components/layout/page";
import { FileList } from "@/components/torrent/file-list";
import { ProgressBar } from "@/components/torrent/progress-bar";
import { RemoveTorrentDialog } from "@/components/torrent/remove-torrent-dialog";
import { StatusBadge } from "@/components/torrent/status-badge";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useLibraryTorrent } from "@/hooks/use-library";
import { useNow } from "@/hooks/use-now";
import {
  ReopenFailedError,
  useAddTorrent,
  useTorrent,
} from "@/hooks/use-torrents";
import { errorMessage, isApiError } from "@/lib/api";
import {
  formatBytes,
  formatElapsed,
  formatPeers,
  formatPercent,
  formatSpeed,
} from "@/lib/format";
import { isInfoHash } from "@/lib/magnet";
import { peopleText } from "@/lib/people-text";
import { type TorrentPageState, watchPath } from "@/lib/routes";

/** After this long without metadata, it's probably a dead torrent. */
const NO_PEERS_HINT_SECONDS = 30;

export function TorrentPage() {
  const { infoHash: raw = "" } = useParams();
  const infoHash = raw.toLowerCase();

  if (!isInfoHash(infoHash)) {
    return (
      <Message
        icon={FileX}
        title="This link doesn't point to a torrent"
        actions={<HomeLink />}
      />
    );
  }
  // A new torrent = a fresh page (dialogs closed, timers restarted).
  return <TorrentView key={infoHash} infoHash={infoHash} />;
}

function TorrentView({ infoHash }: { infoHash: string }) {
  const query = useTorrent(infoHash);
  const library = useLibraryTorrent(infoHash);
  const navigate = useNavigate();
  const location = useLocation();
  const [removeOpen, setRemoveOpen] = useState(false);

  const torrent = query.data;
  // The library knows the name even before the torrent is open again.
  const name = torrent?.name ?? library.data?.torrent.name ?? null;
  useDocumentTitle(name);

  // Just added with only one thing to watch: skip this page. replace, so
  // Back from the player doesn't land here and bounce again.
  const justAdded =
    (location.state as TorrentPageState | null)?.justAdded === true;
  useEffect(() => {
    if (!justAdded || torrent?.status !== "ready") return;
    const videos = torrent.files.filter((file) => file.kind === "video");
    const only = videos.length === 1 ? videos[0] : undefined;
    if (only) void navigate(watchPath(infoHash, only.index), { replace: true });
  }, [justAdded, torrent, infoHash, navigate]);

  if (query.isPending) {
    return (
      <Message
        busy
        title={
          query.fetchStatus === "paused" ? (
            "Waiting for the playback engine…"
          ) : name ? (
            <>
              Opening <bdi>{name}</bdi>…
            </>
          ) : (
            "Opening the torrent…"
          )
        }
      />
    );
  }

  // No data = the first load failed. (A failed refresh keeps showing the
  // torrent, with a warning below.)
  if (torrent === undefined) {
    return (
      <LoadError
        infoHash={infoHash}
        name={name}
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const openRemove = () => {
    setRemoveOpen(true);
  };

  return (
    <Page className="gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            {/* dir="auto": a Hebrew or Arabic name reads (and wraps) from
                its own side. */}
            <h1
              dir={name ? "auto" : undefined}
              className="text-start text-xl font-semibold tracking-tight [overflow-wrap:anywhere] sm:text-2xl"
            >
              {name ?? "Finding the file list…"}
            </h1>
            <div className="flex min-w-0 items-center gap-2">
              <StatusBadge {...torrent} />
              <span className="truncate font-mono text-xs text-muted-foreground select-text">
                {infoHash}
              </span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={openRemove}>
            <Trash2 aria-hidden />
            Remove…
          </Button>
        </div>
        <Stats torrent={torrent} />
      </div>

      {query.isError && !isApiError(query.error, 404) && (
        <Alert tone="warning" title="Couldn't refresh this torrent">
          <div className="flex flex-col items-start gap-2">
            {errorMessage(query.error)}
            <Button
              variant="outline"
              size="sm"
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Try again
            </Button>
          </div>
        </Alert>
      )}

      {torrent.status === "fetching_metadata" && (
        <FetchingMetadata torrent={torrent} onRemove={openRemove} />
      )}

      {torrent.status === "checking" && <CheckingData />}

      {torrent.status === "error" && (
        <Alert tone="danger" title="This torrent stopped working">
          <div className="flex flex-col items-start gap-2">
            {peopleText(torrent.error, "Something went wrong with it.")}
            <Button variant="outline" size="sm" onClick={openRemove}>
              Remove it
            </Button>
          </div>
        </Alert>
      )}

      {torrent.status === "ready" && (
        <FileList
          infoHash={infoHash}
          torrentName={torrent.name}
          files={torrent.files}
          progress={library.data?.progress}
        />
      )}

      <RemoveTorrentDialog
        target={removeOpen ? { infoHash, name } : null}
        onClose={() => {
          setRemoveOpen(false);
        }}
        onRemoved={() => void navigate("/", { replace: true })}
      />
    </Page>
  );
}

function Stats({ torrent }: { torrent: TorrentDetail }) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-muted-foreground tabular-nums">
        <Stat icon={HardDrive} label="Downloaded">
          {torrent.size !== null
            ? `${formatPercent(torrent.progress)} of ${formatBytes(torrent.size)}`
            : "Size not known yet"}
        </Stat>
        <Stat icon={Users} label="Peers">
          {formatPeers(torrent.peers)}
        </Stat>
        <Stat icon={ArrowDown} label="Download speed">
          {formatSpeed(torrent.downloadSpeed)}
        </Stat>
        <Stat icon={ArrowUp} label="Upload speed">
          {formatSpeed(torrent.uploadSpeed)}
        </Stat>
      </div>
      {torrent.size !== null && <ProgressBar value={torrent.progress} />}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5" title={label}>
      <Icon className="size-4" aria-hidden />
      <span className="sr-only">{label}: </span>
      {children}
    </span>
  );
}

function FetchingMetadata({
  torrent,
  onRemove,
}: {
  torrent: TorrentDetail;
  onRemove: () => void;
}) {
  const now = useNow();
  // When this page started waiting. addedAt counts when it's recent; an old
  // one is from an earlier session (it was opened again), not this wait.
  const [shownAt] = useState(() => Date.now());
  const addedAt = Date.parse(torrent.addedAt);
  const start =
    Number.isNaN(addedAt) || addedAt < shownAt - 60 * 60_000
      ? shownAt
      : addedAt;
  const elapsed = (now - start) / 1000;

  return (
    <div className="flex flex-col gap-3">
      <Card
        variant="muted"
        className="flex flex-col items-center gap-3 py-10 text-center"
      >
        <Spinner size="lg" tone="muted" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Finding peers and the file list…</p>
          <p className="text-sm text-muted-foreground tabular-nums">
            {formatPeers(torrent.peers)} so far · waiting{" "}
            {formatElapsed(elapsed)}
          </p>
        </div>
      </Card>
      {elapsed >= NO_PEERS_HINT_SECONDS && (
        <Alert tone="warning" title="Nobody seems to be sharing this">
          <div className="flex flex-col items-start gap-2">
            Keep waiting, or remove it.
            <Button variant="outline" size="sm" onClick={onRemove}>
              Remove…
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}

/**
 * After a restart without a resume record, the engine checks the pieces
 * already on disk before anything can play. It isn't waiting for peers, so
 * no "nobody seems to be sharing" hint here.
 */
function CheckingData() {
  return (
    <Card
      variant="muted"
      className="flex flex-col items-center gap-3 py-10 text-center"
    >
      <Spinner size="lg" tone="muted" />
      <div className="flex flex-col gap-1">
        <p className="font-medium">Checking downloaded data…</p>
        <p className="text-sm text-balance text-muted-foreground">
          Streamy is making sure what's already downloaded is complete. The
          videos can play when it's done.
        </p>
      </div>
    </Card>
  );
}

/** The first load failed: removed, couldn't be opened again, or an error. */
function LoadError({
  infoHash,
  name,
  error,
  retrying,
  onRetry,
}: {
  infoHash: string;
  name: string | null;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const add = useAddTorrent();

  // Removed in this window (a 404 is otherwise answered by opening it again).
  if (isApiError(error, 404)) {
    return (
      <Message
        icon={CloudOff}
        title={
          name ? (
            <>
              <bdi>{name}</bdi> was removed
            </>
          ) : (
            "This torrent was removed"
          )
        }
        description="Open it again to keep watching. It downloads again."
        actions={
          <>
            <Button
              loading={add.isPending}
              onClick={() => {
                add.mutate({ kind: "magnet", magnet: infoHash });
              }}
            >
              Open it again
            </Button>
            <HomeLink />
          </>
        }
      >
        {add.error && (
          <Alert tone="danger" className="w-full text-left">
            {errorMessage(add.error)}
          </Alert>
        )}
      </Message>
    );
  }

  return (
    <Message
      icon={TriangleAlert}
      title={
        <>
          {error instanceof ReopenFailedError
            ? "Couldn't open "
            : "Couldn't load "}
          {name ? <bdi>{name}</bdi> : "this torrent"}
        </>
      }
      description={errorMessage(error)}
      actions={
        <>
          <Button variant="outline" loading={retrying} onClick={onRetry}>
            Try again
          </Button>
          <HomeLink />
        </>
      }
    />
  );
}

/** A centered message for the whole page: what happened and what to do. */
function Message({
  icon: Icon,
  busy = false,
  title,
  description,
  actions,
  children,
}: {
  icon?: LucideIcon;
  busy?: boolean;
  /** Put a torrent's name in <bdi>, so a right-to-left one stays whole. */
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Page className="items-center justify-center gap-4 text-center">
      {busy ? (
        <Spinner size="lg" tone="muted" />
      ) : (
        Icon && (
          <span className="flex size-12 items-center justify-center rounded-full bg-accent text-muted-foreground">
            <Icon className="size-6" aria-hidden />
          </span>
        )
      )}
      <div className="flex max-w-md flex-col gap-1">
        <h1 className="text-lg font-semibold [overflow-wrap:anywhere]">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-balance text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      )}
      {children && <div className="w-full max-w-md">{children}</div>}
    </Page>
  );
}

function HomeLink() {
  return (
    <Link to="/" className={buttonVariants({ variant: "outline" })}>
      Home
    </Link>
  );
}

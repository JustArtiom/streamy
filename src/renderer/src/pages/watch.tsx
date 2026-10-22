import { CloudOff, FileX, Home, RotateCw, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import type { FileProgress, TorrentDetail } from "../../../shared/engine-api";
import { type Neighbour, Player } from "@/components/player/player";
import {
  Center,
  CHECKING_DETAIL,
  CHECKING_TITLE,
  PlayerMessage,
  Ring,
} from "@/components/player/player-overlays";
import { ResumePrompt } from "@/components/player/resume-prompt";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useGoBack } from "@/hooks/use-history-nav";
import { useLibraryTorrent, useThumbnailPath } from "@/hooks/use-library";
import { useMediaInfo } from "@/hooks/use-media";
import { useNow } from "@/hooks/use-now";
import {
  ReopenFailedError,
  useAddTorrent,
  useTorrent,
} from "@/hooks/use-torrents";
import { errorMessage, isApiError } from "@/lib/api";
import { readableName } from "@/lib/file-names";
import { formatPeers, formatSwarm } from "@/lib/format";
import { isInfoHash } from "@/lib/magnet";
import { naturalSortBy } from "@/lib/natural-sort";
import { peopleText } from "@/lib/people-text";
import { resumePosition } from "@/lib/resume";
import type { WatchPageState } from "@/lib/routes";
import { useSettings } from "@/lib/settings";

/** Files Chromium may play as they are when ffmpeg isn't working. */
const PLAYABLE_AS_IS = /\.(mp4|m4v|webm)$/i;
/** After this long without metadata, it's probably a dead torrent. */
const NO_PEERS_HINT_SECONDS = 30;

/** The player page: /watch/:infoHash/:fileIndex. */
export function WatchPage() {
  const params = useParams();
  const infoHash = (params.infoHash ?? "").toLowerCase();
  const fileIndex = Number(params.fileIndex);

  if (!isInfoHash(infoHash) || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return (
      <Frame>
        <PlayerMessage
          title="This link doesn't point to a video"
          icon={<FileX />}
          actions={<HomeLink />}
        />
      </Frame>
    );
  }

  // A new file = a fresh player (the old session stops, its position is
  // saved, and the new file gets its own resume question).
  return (
    <WatchFile
      key={`${infoHash}:${fileIndex}`}
      infoHash={infoHash}
      fileIndex={fileIndex}
    />
  );
}

/** Waits for the library: where to start depends on the saved position. */
function WatchFile({
  infoHash,
  fileIndex,
}: {
  infoHash: string;
  fileIndex: number;
}) {
  const library = useLibraryTorrent(infoHash);
  // A failed library (or one that doesn't know the torrent) just means
  // there's nothing to resume.
  if (library.isPending && library.fetchStatus !== "idle") {
    return (
      <Frame>
        <Loading title="Loading…" />
      </Frame>
    );
  }
  const progress =
    library.data?.progress.find((item) => item.fileIndex === fileIndex) ?? null;
  return (
    <WatchView
      infoHash={infoHash}
      fileIndex={fileIndex}
      savedProgress={progress}
    />
  );
}

/** Where to start playing, once decided. */
type StartChoice = {
  /** Movie time (s). */
  at: number;
  /** Tracks to restore (resuming only). */
  savedTracks: Pick<FileProgress, "audioTrack" | "subtitle"> | null;
};

/**
 * From the position saved when the page opened (later saves, made while
 * watching, mustn't move it): start at once, or null = ask.
 */
function initialStart(
  progress: FileProgress | null,
  preset: WatchPageState["start"],
): StartChoice | null {
  const resumeAt = resumePosition(progress);
  if (resumeAt === null || !progress || preset === "beginning") {
    return { at: 0, savedTracks: null };
  }
  if (preset === "resume") return { at: resumeAt, savedTracks: progress };
  return null;
}

function WatchView({
  infoHash,
  fileIndex,
  savedProgress,
}: {
  infoHash: string;
  fileIndex: number;
  savedProgress: FileProgress | null;
}) {
  const location = useLocation();
  const torrentQuery = useTorrent(infoHash);
  const library = useLibraryTorrent(infoHash);
  const mediaQuery = useMediaInfo(infoHash, fileIndex);
  const thumbnailPath = useThumbnailPath(infoHash, fileIndex);
  const settings = useSettings();
  const preset = (location.state as WatchPageState | null)?.start;
  const [start, setStart] = useState(() => initialStart(savedProgress, preset));

  const torrent = torrentQuery.data;
  const file = torrent?.files.find((item) => item.index === fileIndex);
  const fileName = file?.name ?? savedProgress?.fileName ?? null;
  const torrentName = torrent?.name ?? library.data?.torrent.name ?? null;
  const title = fileName
    ? readableName(fileName)
    : torrentName
      ? readableName(torrentName)
      : "Video";
  // The torrent's name only when it says something the title doesn't.
  const subtitle =
    torrentName && readableName(torrentName) !== title ? torrentName : null;

  useDocumentTitle(fileName ?? torrentName);

  // Removed in this window (otherwise a 404 is answered by opening it again).
  if (isApiError(torrentQuery.error, 404)) {
    return (
      <Frame>
        <TorrentGone infoHash={infoHash} name={torrentName} />
      </Frame>
    );
  }

  if (torrent === undefined && torrentQuery.isError) {
    return (
      <Frame>
        <PlayerMessage
          title={
            torrentQuery.error instanceof ReopenFailedError
              ? `Couldn't open ${torrentName ?? "this torrent"}`
              : `Couldn't load ${torrentName ?? "this torrent"}`
          }
          message={errorMessage(torrentQuery.error)}
          actions={
            <>
              <Button
                loading={torrentQuery.isFetching}
                onClick={() => void torrentQuery.refetch()}
              >
                <RotateCw />
                Try again
              </Button>
              <HomeLink variant="outline" />
            </>
          }
        />
      </Frame>
    );
  }

  if (torrent?.status === "error") {
    return (
      <Frame>
        <PlayerMessage
          title="This torrent stopped working"
          // The engine's words when they're for people (a raw system
          // error went to its log instead).
          message={peopleText(torrent.error, "Something went wrong with it.")}
          actions={<BackButton />}
        />
      </Frame>
    );
  }

  if (torrent?.status === "ready" && !file) {
    return (
      <Frame>
        <PlayerMessage
          title="This file isn't in the torrent"
          icon={<FileX />}
          actions={<BackButton />}
        />
      </Frame>
    );
  }

  if (start === null && savedProgress) {
    return (
      <Frame>
        <ResumePrompt
          title={title}
          position={savedProgress.position}
          duration={savedProgress.duration}
          thumbnailPath={thumbnailPath}
          onResume={() => {
            setStart({
              at: savedProgress.position,
              savedTracks: savedProgress,
            });
          }}
          onStartOver={() => {
            setStart({ at: 0, savedTracks: null });
          }}
        />
      </Frame>
    );
  }

  const neighbours = neighboursOf(torrent, fileIndex);
  const playerProps = {
    infoHash,
    fileIndex,
    title,
    subtitle,
    torrent,
    start: start?.at ?? 0,
    savedTracks: start?.savedTracks ?? null,
    previous: neighbours.previous,
    next: neighbours.next,
  };

  const error = mediaQuery.error;
  if (error) {
    // ffmpeg isn't working: an MP4/WebM may still play as it is.
    const noFfmpeg = isApiError(error, 503) && /ffmpeg/i.test(error.message);
    if (noFfmpeg && file && PLAYABLE_AS_IS.test(file.name) && settings) {
      return <Player {...playerProps} media={null} />;
    }
    if (noFfmpeg && !file) {
      // Need the file name to know; the torrent is on its way.
      return (
        <Frame>
          <Preparing torrent={torrent} />
        </Frame>
      );
    }
    return (
      <Frame>
        <MediaError
          error={error}
          noFfmpeg={noFfmpeg}
          retrying={mediaQuery.isFetching}
          onRetry={() => void mediaQuery.refetch()}
        />
      </Frame>
    );
  }

  if (!mediaQuery.data || !settings) {
    const waitingForEngine =
      torrentQuery.fetchStatus === "paused" ||
      mediaQuery.fetchStatus === "paused";
    return (
      <Frame>
        {waitingForEngine ? (
          <Loading title="Waiting for the playback engine…" />
        ) : (
          <Preparing torrent={torrent} />
        )}
      </Frame>
    );
  }

  return <Player {...playerProps} media={mediaQuery.data} />;
}

/** The previous and next video in the torrent, in natural order ("E2" before "E10"). */
function neighboursOf(
  torrent: TorrentDetail | undefined,
  fileIndex: number,
): { previous: Neighbour | null; next: Neighbour | null } {
  if (!torrent) return { previous: null, next: null };
  const videos = naturalSortBy(
    torrent.files.filter((file) => file.kind === "video"),
    (file) => file.path,
  );
  const at = videos.findIndex((file) => file.index === fileIndex);
  const neighbour = (offset: number): Neighbour | null => {
    const file = at === -1 ? undefined : videos[at + offset];
    return file ? { fileIndex: file.index, name: file.name } : null;
  };
  return { previous: neighbour(-1), next: neighbour(1) };
}

/** The dark frame of the player, for everything that isn't playing yet. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-black text-foreground [color-scheme:dark]">
      {children}
    </div>
  );
}

function Loading({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <Center>
      <Ring />
      <p className="text-sm font-medium text-white">{title}</p>
      {detail && <p className="max-w-xs text-xs text-white/70">{detail}</p>}
    </Center>
  );
}

/**
 * Before the player: the torrent's file list (finding peers), a check of
 * the data already on disk (after a restart), then the video's info
 * (ffprobe). These can take a while on a slow torrent, so the live numbers
 * show after a few seconds.
 */
function Preparing({ torrent }: { torrent: TorrentDetail | undefined }) {
  const [since] = useState(() => Date.now());
  const now = useNow(1000);
  const seconds = (now - since) / 1000;

  if (!torrent) return <Loading title="Loading…" />;

  if (torrent.status === "checking") {
    // Peers aren't what's missing: no "Finding peers", no "nobody shares".
    return (
      <Loading
        title={CHECKING_TITLE}
        detail={seconds >= 6 ? CHECKING_DETAIL : null}
      />
    );
  }

  if (torrent.status === "fetching_metadata") {
    return (
      <Loading
        title="Finding peers…"
        detail={
          seconds >= NO_PEERS_HINT_SECONDS && torrent.peers === 0
            ? "Nobody seems to be sharing this yet. Keep waiting, or go back."
            : `${formatPeers(torrent.peers)} so far`
        }
      />
    );
  }
  return (
    <Loading
      title="Preparing video…"
      detail={
        seconds >= 6
          ? `This can take a while on a slow torrent · ${formatSwarm(torrent)}`
          : null
      }
    />
  );
}

function MediaError({
  error,
  noFfmpeg,
  retrying,
  onRetry,
}: {
  error: Error;
  noFfmpeg: boolean;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (noFfmpeg) {
    return (
      <PlayerMessage
        title="This video needs converting"
        message="It can't be played as it is, and Streamy can't convert it because ffmpeg isn't working. Reinstalling Streamy should fix it."
        icon={<FileX />}
        actions={<BackButton />}
      />
    );
  }
  if (isApiError(error, 400)) {
    // "This file has no video", or another reason the engine gave.
    return (
      <PlayerMessage
        title={errorMessage(error)}
        icon={<FileX />}
        actions={<BackButton />}
      />
    );
  }
  return (
    <PlayerMessage
      title={
        isApiError(error, 0)
          ? "Can't reach the playback engine"
          : "Couldn't read the video"
      }
      message={errorMessage(error)}
      icon={<TriangleAlert />}
      actions={
        <>
          <Button loading={retrying} onClick={onRetry}>
            <RotateCw />
            Try again
          </Button>
          <BackButton />
        </>
      }
    />
  );
}

/** Removed in this window while (or before) watching. */
function TorrentGone({
  infoHash,
  name,
}: {
  infoHash: string;
  name: string | null;
}) {
  const add = useAddTorrent();

  return (
    <PlayerMessage
      title={name ? `${name} was removed` : "This torrent was removed"}
      message={
        add.error
          ? errorMessage(add.error)
          : "Open it again to keep watching. It downloads again."
      }
      icon={<CloudOff />}
      actions={
        <>
          <Button
            loading={add.isPending}
            onClick={() => {
              add.mutate({ kind: "magnet", magnet: infoHash });
            }}
          >
            <RotateCw />
            Open it again
          </Button>
          <HomeLink variant="outline" />
        </>
      }
    />
  );
}

function HomeLink({
  variant = "primary",
}: {
  variant?: "primary" | "outline";
}) {
  return (
    <Link to="/" className={buttonVariants({ variant })}>
      <Home />
      Home
    </Link>
  );
}

function BackButton() {
  const goBack = useGoBack();
  return (
    <Button variant="outline" onClick={goBack}>
      Back
    </Button>
  );
}

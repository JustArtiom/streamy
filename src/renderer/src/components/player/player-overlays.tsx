import { AlertTriangle, Home, Play, RotateCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import type { EngineStatus } from "../../../../shared/api";
import type {
  PlaybackMode,
  TorrentSummary,
} from "../../../../shared/engine-api";
import type {
  EngineError,
  EnginePhase,
} from "@/components/player/playback-engine";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/cn";
import { formatSwarm } from "@/lib/format";
import { peopleText } from "@/lib/people-text";

/** The big white spinner over the video. */
export function Ring({ label = "Loading" }: { label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="block size-12 animate-spin rounded-full border-[3px] border-white/20 border-t-white"
    />
  );
}

/** Text in the middle of the video, readable on any picture. */
export function Center({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
      <div className="flex flex-col items-center gap-3 text-center [text-shadow:0_1px_3px_rgb(0_0_0/60%)]">
        {children}
      </div>
    </div>
  );
}

/**
 * What the wait is about while the torrent checks the data it already has
 * on disk (after a restart): its file list is known, but nothing plays
 * until that's done. Not "Finding peers": peers aren't the problem.
 */
export const CHECKING_TITLE = "Checking downloaded data…";
/** Shown once the check has taken a few seconds. */
export const CHECKING_DETAIL = "This can take a while for a big torrent";

type LoadingProps = {
  phase: EnginePhase;
  waiting: boolean;
  mode: PlaybackMode | null;
  torrent: TorrentSummary | undefined;
};

/**
 * Spinner with context. Starting a session can take seconds (ffmpeg waits
 * for its first segment); buffering mid-movie usually means the torrent is
 * slow, so after 15 s we say so with its live numbers.
 */
export function LoadingOverlay(props: LoadingProps) {
  const starting =
    props.phase === "preparing" ||
    props.phase === "loading" ||
    props.phase === "idle";
  if (!starting && !props.waiting) return null;
  // Remounted for each wait, so its clock starts from zero every time.
  return (
    <ActiveLoading
      key={starting ? "starting" : "waiting"}
      {...props}
      starting={starting}
    />
  );
}

function ActiveLoading({
  phase,
  waiting,
  mode,
  torrent,
  starting,
}: LoadingProps & { starting: boolean }) {
  const [since] = useState(() => Date.now());
  const now = useNow(250);
  const seconds = (now - since) / 1000;
  // A quick seek inside the buffer shouldn't flash a spinner.
  if (!starting && seconds < 0.5) return null;

  // The engine answers starts with "not yet" (409) until the check is done.
  const checking =
    (phase === "preparing" || phase === "idle") &&
    torrent?.status === "checking";
  let title = "Loading…";
  if (checking) title = CHECKING_TITLE;
  else if (phase === "preparing" || phase === "idle")
    title = "Preparing video…";
  else if (mode === "transcode") title = "Converting video…";
  else if (phase === "loading" && mode === "remux") title = "Preparing video…";

  const swarm = torrent ? formatSwarm(torrent) : null;
  let detail: string | null = null;
  if (waiting && !starting && seconds >= 15) {
    detail = swarm ? `Waiting for pieces · ${swarm}` : "Waiting for pieces…";
  } else if (checking && seconds >= 6) {
    detail = CHECKING_DETAIL;
  } else if (starting && seconds >= 6) {
    detail = swarm
      ? `This can take a while on a slow torrent · ${swarm}`
      : "This can take a while on a slow torrent";
  }

  return (
    <Center>
      <Ring />
      <p className="text-sm font-medium text-white">{title}</p>
      {detail && <p className="max-w-xs text-xs text-white/70">{detail}</p>}
    </Center>
  );
}

/**
 * The playback engine stopped and is being started again. Not an error:
 * the video carries on from here once it's back.
 */
export function ReconnectingOverlay({
  status,
}: {
  status: EngineStatus | null;
}) {
  const failed = status?.state === "failed";
  return (
    <Center>
      <Ring label="Reconnecting" />
      <p className="text-sm font-medium text-white">Reconnecting…</p>
      <p className="max-w-xs text-xs text-white/70">
        {failed
          ? "The playback engine keeps stopping. Streamy will try again in a minute."
          : "The playback engine stopped. The video goes on from here once it's back."}
      </p>
    </Center>
  );
}

export function BigPlayButton({ onPlay }: { onPlay: () => void }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <button
        type="button"
        aria-label="Play"
        onClick={onPlay}
        className="pointer-events-auto flex size-20 items-center justify-center rounded-full bg-black/55 text-white ring-1 ring-white/20 backdrop-blur-sm transition-transform outline-none hover:scale-105 focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <Play className="size-8 translate-x-0.5 fill-current" />
      </button>
    </div>
  );
}

/** A message over the (dimmed) video: errors, a removed torrent… */
export function PlayerMessage({
  title,
  message,
  icon,
  actions,
  busy = false,
}: {
  title: string;
  message?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  /** Something is under way (a spinner instead of the icon). */
  busy?: boolean;
}) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div
        role={busy ? "status" : "alert"}
        className="flex max-w-sm flex-col items-center gap-4 text-center"
      >
        {busy ? (
          <Ring />
        ) : (
          <span className="flex size-12 items-center justify-center rounded-full bg-white/10 text-white [&_svg]:size-6">
            {icon ?? <AlertTriangle />}
          </span>
        )}
        <div className="flex flex-col gap-1.5">
          <h2 className="text-lg font-semibold text-balance [overflow-wrap:anywhere] text-white">
            {title}
          </h2>
          {message && (
            <p className="text-sm text-balance text-white/70">{message}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap justify-center gap-2">{actions}</div>
        )}
      </div>
    </div>
  );
}

export function ErrorOverlay({
  error,
  onRetry,
}: {
  error: EngineError;
  onRetry: () => void;
}) {
  return (
    <PlayerMessage
      title={error.title}
      // Already a sentence for people; the net catches a raw error anyway.
      message={peopleText(error.message)}
      actions={
        error.kind === "removed" ? (
          <Link to="/" className={buttonVariants({ variant: "primary" })}>
            <Home />
            Home
          </Link>
        ) : (
          <Button onClick={onRetry}>
            <RotateCw />
            Retry
          </Button>
        )
      }
    />
  );
}

/** A short confirmation in the middle after a shortcut ("+10 s", "Volume 40%"). */
export function Flash({
  flash,
}: {
  flash: { id: number; content: ReactNode } | null;
}) {
  if (!flash) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-[18%] z-20 flex justify-center">
      <div
        key={flash.id}
        className={cn(
          "flex items-center gap-2 rounded-full bg-black/65 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm [&_svg]:size-4",
          "animate-flash",
        )}
      >
        {flash.content}
      </div>
    </div>
  );
}

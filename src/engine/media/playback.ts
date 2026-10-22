import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CreatePlaybackRequest,
  Playback,
  PlaybackMode,
  PlaybackState,
  PlaybackStatus,
  SubtitleCuesResponse,
} from "../../shared/engine-api";
import { redact } from "../../shared/redact";
import { cachePaths, getRuntime } from "../config";
import { AppError, ErrorCode } from "../http/errors";
import { logger } from "../lib/logger";
import { ensureVideoFolder, makeDirIn } from "../lib/video-folder";
import { assertEnoughDiskSpace } from "../routes/v1/guards";
import type { InternalFileUrl } from "../torrents/file-tokens";
import { torrentService } from "../torrents/service";
import { trackChild } from "./children";
import { decide } from "./decide";
import { encoderForNewSession, getToneMapper } from "./encoders";
import {
  buildSessionArgs,
  PLAYLIST_FILE,
  type SessionJob,
  subtitleFile,
  type ToneMapper,
} from "./ffmpeg-args";
import { mediaInfoService } from "./media-info";
import {
  blockingReloadLimitMs,
  hasSegment,
  type PlaylistSummary,
  parsePlaylist,
  producedUntil,
} from "./playlist";
import { probeFirstFrameTime, probeSessionOffset } from "./probe";
import {
  ffmpegMissingError,
  ffmpegSpawnOptions,
  isMissingProgram,
} from "./run";
import { subtitlesService } from "./subtitles";
import { inputAllowance, throttleAction } from "./throttle";
import { cuesBetween } from "./vtt";

/*
 * Playback sessions. "direct" is only a record (the player reads the
 * torrent stream itself). remux/transcode run one ffmpeg each, writing HLS
 * into <cacheDir>/playback/<id>/ from `start` onwards; a far seek is a new
 * session.
 *
 * Every session belongs to a player (one per video on screen): starting a
 * session ends that player's other sessions, including a start still in
 * progress.
 *
 * ffmpeg reads the file through a token URL whose bytes are held back while
 * the session is far ahead of the viewer (see throttle.ts).
 *
 * A session ends on DELETE (of it or of its player), after
 * playbackIdleSeconds without a heartbeat or request, when its torrent goes
 * away, or on shutdown. Ending it always kills ffmpeg, revokes its file
 * token and deletes its folder.
 */

const log = logger.child({ module: "playback" });

/** Embedded text tracks extracted per session, at most. */
const MAX_SUBTITLE_OUTPUTS = 32;
/** ffmpeg stderr lines kept per session, for logs. */
const STDERR_LINES = 50;
const IDLE_CHECK_MS = 15_000;
/** How often each session's lead over the viewer is checked. */
const THROTTLE_CHECK_MS = 1_000;
const STOP_GRACE_MS = 3_000;
/** At shutdown there's less time: main kills us after 3 s. */
const SHUTDOWN_GRACE_MS = 1_000;
const POLL_MS = 200;
/** How often a blocking playlist reload looks for the next segment. */
const BLOCKING_POLL_MS = 100;
/** ffmpeg "finished" this far before the end of the movie didn't finish. */
const END_SLACK_SECONDS = 5;

export const HLS_FILE_PATTERN = /^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/;

// What people see. ffmpeg's own output stays in the log.
const START_FAILED_MESSAGE = "Streamy couldn't prepare this video for playing.";
const PLAYBACK_FAILED_MESSAGE =
  "Streamy couldn't prepare the rest of this video.";
const SUPERSEDED_MESSAGE = "A newer playback replaced this one";
const STOPPED_MESSAGE = "This playback was stopped before it started";

/**
 * ffmpeg lines that mean it lost its input (the connection dropped and
 * reconnecting failed). ffmpeg then ends the output as if the movie had
 * ended, and exits 0.
 */
const INPUT_LOST =
  /prematurely|Error during demuxing|HTTP error|Server returned|Input\/output error|Connection refused|Connection reset/i;

/** A heartbeat arrived: what the library saves for "Continue watching". */
export type PlaybackHeartbeatEvent = {
  sessionId: string;
  infoHash: string;
  fileIndex: number;
  /** "Sintel.mp4" */
  fileName: string;
  /** Movie time (s). */
  position: number;
  /** The whole movie (s). */
  duration: number;
  paused: boolean;
  /** The audio track asked for (AudioTrack.index); null = the file's default. */
  audioTrack: number | null;
  /** SubtitleTrack.id shown, null = off, undefined = not said (keep what's saved). */
  subtitle: string | null | undefined;
};

type FfmpegRun = {
  child: ChildProcess;
  exited: boolean;
  code: number | null;
  spawnError: Error | null;
};

type Session = {
  id: string;
  playerId: string;
  infoHash: string;
  fileIndex: number;
  fileName: string;
  /** What the request asked for (null = the file's default). */
  audioTrack: number | null;
  mode: PlaybackMode;
  playback: Playback;
  /** HLS folder (ffmpeg's working directory); null for direct. */
  dir: string | null;
  /** ffmpeg's input URL (remux/transcode); revoked when the session ends. */
  input: InternalFileUrl | null;
  run: FfmpegRun | null;
  state: PlaybackState;
  offset: number;
  /** The movie time asked for: the viewer's position until a heartbeat says otherwise. */
  requestedStart: number;
  lastSeenAt: number;
  position: number | null;
  paused: boolean;
  /** The playlist's mtime when producedUntil was last computed. */
  playlistMtimeMs: number;
  producedUntil: number | null;
  subtitleStreams: number[];
  error: string | null;
  stderr: string[];
  /**
   * create() hasn't returned yet: no idle stop, no throttling, and an
   * ffmpeg exit is the start code's business.
   */
  creating: boolean;
  /** Its input is held back (ffmpeg is far ahead of the viewer). */
  held: boolean;
  /** The file's average size per second of movie; null when unknown. */
  bytesPerSecond: number | null;
  stopping: boolean;
};

/** A create() under way. Aborted when its player starts another one, or closes. */
type PendingStart = {
  playerId: string;
  abort: AbortController;
};

const sessions = new Map<string, Session>();
const pendingStarts = new Set<PendingStart>();
const heartbeatListeners = new Set<(event: PlaybackHeartbeatEvent) => void>();

let idleTimer: NodeJS.Timeout | null = null;
let throttleTimer: NodeJS.Timeout | null = null;
let unsubscribeRemovals: (() => void) | null = null;

// ─── Lifecycle ───────────────────────────────────────────────────────────────

function ensureStarted() {
  if (!idleTimer) {
    idleTimer = setInterval(() => void stopIdleSessions(), IDLE_CHECK_MS);
    idleTimer.unref();
  }
  if (!throttleTimer) {
    throttleTimer = setInterval(
      () => void updateThrottles(),
      THROTTLE_CHECK_MS,
    );
    throttleTimer.unref();
  }

  if (!unsubscribeRemovals) {
    try {
      unsubscribeRemovals = torrentService.onRemoved(
        (infoHash) => void stopTorrentSessions(infoHash),
      );
    } catch (error) {
      log.warn({ err: error }, "Couldn't listen for removed torrents");
    }
  }
}

async function stopIdleSessions() {
  const idleBefore =
    Date.now() - getRuntime().tuning.playbackIdleSeconds * 1000;
  const idle = [...sessions.values()].filter(
    // A session still being created is inside its POST request.
    (s) => !s.creating && s.lastSeenAt < idleBefore,
  );
  await Promise.all(
    idle.map((s) => {
      log.info({ id: s.id }, "Stopping idle playback session");
      return stopSession(s.id);
    }),
  );
}

async function stopTorrentSessions(infoHash: string) {
  const matching = [...sessions.values()].filter(
    (s) => s.infoHash === infoHash,
  );
  await Promise.all(matching.map((s) => stopSession(s.id)));
}

/**
 * Ends every session and unfinished start of a player, except `keep` (the
 * start that's asking). The starts answer their request with `reason`.
 */
async function stopPlayer(
  playerId: string,
  reason: AppError,
  keep?: PendingStart,
) {
  for (const pending of pendingStarts) {
    if (pending.playerId === playerId && pending !== keep) {
      pending.abort.abort(reason);
    }
  }
  const matching = [...sessions.values()].filter(
    (s) => s.playerId === playerId,
  );
  await Promise.all(matching.map((s) => stopSession(s.id)));
}

/** Asked again after an await: a stop may have come in meanwhile. */
function isStopping(session: Session): boolean {
  return session.stopping;
}

function isRunning(run: FfmpegRun | null): run is FfmpegRun {
  return run !== null && !run.exited;
}

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Deletes a session folder. Windows may hold a file open a moment longer (EBUSY). */
async function removeDir(dir: string) {
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

async function killRun(id: string, run: FfmpegRun | null, graceMs: number) {
  if (!isRunning(run)) return;
  run.child.kill("SIGTERM");
  if (!(await waitForExit(run.child, graceMs))) {
    log.warn({ id }, "ffmpeg ignored SIGTERM, killing it");
    run.child.kill("SIGKILL");
    await waitForExit(run.child, graceMs);
  }
}

/** Kills ffmpeg, then deletes the folder. Never throws (a stop must always work). */
async function stopSession(id: string, graceMs = STOP_GRACE_MS) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session.stopping = true;
  // Also ends a read held back by throttling: ffmpeg isn't left waiting.
  session.input?.revoke();

  await killRun(id, session.run, graceMs);

  if (session.dir) {
    subtitlesService.forgetSessionDir(session.dir);
    try {
      await removeDir(session.dir);
    } catch (err) {
      // Left for the cleanup at the next start (playback/ is emptied then).
      log.warn({ err, id }, "Couldn't delete a playback session's folder");
    }
  }
  log.info({ id, mode: session.mode }, "Playback session stopped");
}

// ─── Throttling ──────────────────────────────────────────────────────────────

/** What the input may read before the first check: the whole lead. */
function startAllowance(session: Session) {
  return inputAllowance({
    held: false,
    ahead: 0,
    aheadSeconds: getRuntime().tuning.transcodeAheadSeconds,
    bytesPerSecond: session.bytesPerSecond,
  });
}

/**
 * Holds the session's input back while ffmpeg is more than
 * transcodeAheadSeconds ahead of the viewer (the last heartbeat's position,
 * or where it asked to start), and lets it go again once the viewer is
 * closer. Runs every second (while starting too) and on every heartbeat.
 */
async function updateThrottle(session: Session) {
  const { input } = session;
  if (!input || session.stopping || !isRunning(session.run)) return;

  await refreshProduced(session);
  if (isStopping(session) || !isRunning(session.run)) return;

  const aheadSeconds = getRuntime().tuning.transcodeAheadSeconds;
  const position = session.position ?? session.requestedStart;
  // Nothing listed yet: it's still at the start.
  const produced = session.producedUntil ?? session.requestedStart;
  const action = throttleAction({
    held: session.held,
    producedUntil: produced,
    position,
    aheadSeconds,
  });
  if (action !== null) {
    session.held = action === "hold";
    log.debug(
      { id: session.id, producedUntil: produced, position },
      session.held
        ? "ffmpeg's input held back (far ahead)"
        : "ffmpeg's input let through",
    );
  }
  input.allow(
    inputAllowance({
      held: session.held,
      ahead: produced - position,
      aheadSeconds,
      bytesPerSecond: session.bytesPerSecond,
    }),
  );
  if (session.state === "running" || session.state === "throttled") {
    session.state = session.held ? "throttled" : "running";
  }
}

async function updateThrottles() {
  try {
    await Promise.all([...sessions.values()].map(updateThrottle));
  } catch (err) {
    log.warn({ err }, "Couldn't check how far ahead playback sessions are");
  }
}

// ─── ffmpeg ──────────────────────────────────────────────────────────────────

function spawnFfmpeg(session: Session, job: SessionJob): FfmpegRun {
  const args = buildSessionArgs(job);
  log.debug({ id: session.id, args }, "Starting ffmpeg");

  const child = trackChild(
    spawn(getRuntime().ffmpegPath, args, {
      ...ffmpegSpawnOptions(),
      // Output names are relative to the session folder.
      cwd: session.dir ?? undefined,
      stdio: ["ignore", "ignore", "pipe"],
    }),
  );
  const run: FfmpegRun = { child, exited: false, code: null, spawnError: null };
  session.run = run;

  let partial = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      // ffmpeg names its input (our token URL) in errors.
      if (line.trim()) session.stderr.push(redact(line.trim()));
    }
    if (session.stderr.length > STDERR_LINES) {
      session.stderr.splice(0, session.stderr.length - STDERR_LINES);
    }
  });

  const finish = (code: number | null) => {
    if (run.exited) return;
    run.exited = true;
    run.code = code;
    void settleExit(session, run);
  };
  child.on("error", (error) => {
    // No pid = it never started (e.g. ffmpeg missing). Otherwise it's a
    // failed kill() on a process that is exiting anyway.
    if (child.pid !== undefined) return;
    run.spawnError = error;
    finish(null);
  });
  child.on("exit", (code) => {
    finish(code);
  });
  return run;
}

/**
 * ffmpeg exited 0 before the end of the movie, after losing its input: the
 * data stopped coming (torrent gone, a read that kept failing). Without
 * this the session would look "finished" and the movie end early.
 */
function endedEarly(session: Session): boolean {
  const produced = session.producedUntil ?? session.offset;
  return (
    produced < session.playback.duration - END_SLACK_SECONDS &&
    session.stderr.some((line) => INPUT_LOST.test(line))
  );
}

/** ffmpeg exited after the session started: finished, or failed. */
async function settleExit(session: Session, run: FfmpegRun) {
  // An earlier attempt, a stop we asked for, or the start code handles it.
  if (session.run !== run || session.stopping || session.creating) return;
  if (run.code === 0) {
    await refreshProduced(session);
    if (session.run !== run || isStopping(session)) return;
    if (!endedEarly(session)) {
      session.state = "finished";
      log.info({ id: session.id }, "ffmpeg reached the end of the movie");
      return;
    }
  }
  session.state = "error";
  session.error = PLAYBACK_FAILED_MESSAGE;
  log.error(
    {
      id: session.id,
      code: run.code,
      producedUntil: session.producedUntil,
      stderr: session.stderr,
    },
    run.code === 0
      ? "ffmpeg lost its input before the end of the movie"
      : "ffmpeg failed during playback",
  );
}

async function playlistHasSegment(dir: string) {
  try {
    return (await readFile(join(dir, PLAYLIST_FILE), "utf8")).includes(
      "#EXTINF",
    );
  } catch {
    return false;
  }
}

type StartOutcome = "ready" | "exited" | "timeout";

/**
 * Stop starting when the client went away (DELETE of its player, or its
 * request closed), the same player started another session, or the session
 * was stopped meanwhile (replaced, torrent removed).
 */
function throwIfCancelled(session: Session | null, signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason instanceof AppError
      ? signal.reason
      : new AppError(ErrorCode.BadRequest, "The request was cancelled");
  }
  if (session?.stopping) {
    throw new AppError(ErrorCode.NotFound, STOPPED_MESSAGE);
  }
}

async function waitForFirstSegment(
  session: Session,
  run: FfmpegRun,
  deadline: number,
  signal: AbortSignal,
): Promise<StartOutcome> {
  const dir = session.dir ?? "";
  for (;;) {
    throwIfCancelled(session, signal);
    // Check exit first, then the playlist: a short run can finish quickly.
    const exited = run.exited;
    if (await playlistHasSegment(dir)) return "ready";
    if (exited) return "exited";
    if (Date.now() > deadline) return "timeout";
    await sleep(POLL_MS);
  }
}

/** Before another attempt: an empty folder, nothing produced, nothing held. */
async function resetForRetry(session: Session) {
  session.stderr = [];
  session.producedUntil = null;
  session.playlistMtimeMs = 0;
  session.held = false;
  session.input?.allow(startAllowance(session));
  const dir = session.dir ?? "";
  await removeDir(dir);
  await makeDirIn(dir);
}

/** The hardware encoder itself failed (no GPU, driver trouble), not the input. */
function hardwareEncoderFailed(session: Session, job: SessionJob): boolean {
  const { video } = job;
  if (video.kind !== "encode" || video.encoder === "libx264") return false;
  return session.stderr.some(
    (line) =>
      line.includes(video.encoder) ||
      /\b(encoder|hwupload|vaapi|qsv|nvenc|cuda|videotoolbox)\b/i.test(line),
  );
}

function startFailedError() {
  return new AppError(ErrorCode.Internal, START_FAILED_MESSAGE);
}

/**
 * Runs ffmpeg until the first segment exists. Retries once with libx264
 * when a hardware encoder fails, and once without subtitle outputs.
 * Returns the job that worked.
 */
async function startFfmpeg(
  session: Session,
  job: SessionJob,
  signal: AbortSignal,
): Promise<SessionJob> {
  const deadline =
    Date.now() + getRuntime().tuning.playbackStartTimeoutSeconds * 1000;
  let attempt = job;

  for (;;) {
    const run = spawnFfmpeg(session, attempt);
    const outcome = await waitForFirstSegment(session, run, deadline, signal);
    // Killed by a stop: not a failure to retry.
    throwIfCancelled(session, signal);
    // A segment from a run that failed right after it (a stream the output
    // can't take) is no start: the player should try something else.
    const failedAfterSegment = run.exited && run.code !== 0;
    if (outcome === "ready" && !failedAfterSegment) return attempt;

    if (outcome === "timeout") {
      log.warn(
        { id: session.id, stderr: session.stderr },
        "ffmpeg didn't start in time",
      );
      throw new AppError(
        ErrorCode.ServiceUnavailable,
        "The video didn't start in time. The torrent may be too slow.",
      );
    }

    if (run.spawnError) {
      if (isMissingProgram(run.spawnError)) throw ffmpegMissingError();
      throw run.spawnError;
    }

    const { video } = attempt;
    if (
      video.kind === "encode" &&
      run.code !== 0 &&
      hardwareEncoderFailed(session, attempt)
    ) {
      log.warn(
        {
          id: session.id,
          encoder: video.encoder,
          code: run.code,
          stderr: session.stderr,
        },
        "The hardware encoder failed, retrying with libx264",
      );
      attempt = { ...attempt, video: { ...video, encoder: "libx264" } };
      session.playback.encoder = "libx264";
      await resetForRetry(session);
      continue;
    }

    // A subtitle track ffmpeg can't convert is a common cause: try again
    // without them (no embedded cues then).
    if (attempt.subtitleStreams.length > 0) {
      log.warn(
        { id: session.id, code: run.code, stderr: session.stderr },
        "ffmpeg failed with subtitle outputs, retrying without them",
      );
      attempt = { ...attempt, subtitleStreams: [] };
      session.subtitleStreams = [];
      await resetForRetry(session);
      continue;
    }

    log.error(
      { id: session.id, code: run.code, stderr: session.stderr },
      "ffmpeg failed before the first segment",
    );
    if (run.code === 0 && outcome !== "ready") {
      throw new AppError(
        ErrorCode.BadRequest,
        "There's nothing to play from this position",
      );
    }
    throw startFailedError();
  }
}

/**
 * Re-reads the playlist when it changed: producedUntil = offset + Σ #EXTINF.
 * While starting, the offset isn't probed yet: the start asked for stands in.
 */
async function refreshProduced(session: Session) {
  if (!session.dir) return;
  const path = join(session.dir, PLAYLIST_FILE);
  try {
    const { mtimeMs } = await stat(path);
    if (mtimeMs === session.playlistMtimeMs && session.producedUntil !== null) {
      return;
    }
    const playlist = parsePlaylist(await readFile(path, "utf8"));
    session.playlistMtimeMs = mtimeMs;
    session.producedUntil = producedUntil(
      session.creating ? session.requestedStart : session.offset,
      playlist,
    );
  } catch {
    // Deleted while stopping: keep the last value.
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Re-encoding sessions: running, or still starting (probing takes a while). */
function countActiveTranscodes() {
  let count = 0;
  for (const s of sessions.values()) {
    if (
      s.mode === "transcode" &&
      !s.stopping &&
      (s.state === "starting" || isRunning(s.run))
    ) {
      count++;
    }
  }
  return count;
}

function getSession(id: string): Session {
  const session = sessions.get(id);
  if (!session) {
    throw new AppError(
      ErrorCode.NotFound,
      "This playback session doesn't exist",
    );
  }
  return session;
}

/** Marks the session (and its torrent, and its file token) as in use. */
function markSeen(session: Session) {
  session.lastSeenAt = Date.now();
  session.input?.touch();
  try {
    torrentService.touch(session.infoHash);
  } catch {
    // The torrent is gone; onRemoved stops this session.
  }
}

function statusOf(session: Session): PlaybackStatus {
  return {
    state: session.state,
    producedUntil: session.dir ? session.producedUntil : null,
    error: session.error,
  };
}

function emitHeartbeat(event: PlaybackHeartbeatEvent) {
  for (const listener of heartbeatListeners) {
    try {
      listener(event);
    } catch (err) {
      log.error({ err }, "A playback onHeartbeat listener failed");
    }
  }
}

/** All of the file is downloaded (its pieces are verified on disk). */
function isFileComplete(infoHash: string, fileIndex: number): boolean {
  try {
    const file = torrentService
      .get(infoHash)
      .files.find((f) => f.index === fileIndex);
    return file?.progress === 1;
  } catch {
    return false;
  }
}

/**
 * While the disk is almost full, downloading is paused: remux/transcode
 * would write to that full disk, and an unfinished file would wait for
 * pieces that won't come. A downloaded file still plays directly.
 */
function refuseOnLowDisk(mode: PlaybackMode, infoHash: string, index: number) {
  if (mode === "direct" && isFileComplete(infoHash, index)) return;
  assertEnoughDiskSpace();
}

const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  mp4: "video/mp4",
  m4s: "video/iso.segment",
};

async function createSession(
  request: CreatePlaybackRequest,
  pending: PendingStart,
  signal: AbortSignal,
): Promise<Playback> {
  // A player shows one video: what it started before is over (a seek, a
  // track change, an earlier start nobody waits for anymore).
  await stopPlayer(
    request.playerId,
    new AppError(ErrorCode.Conflict, SUPERSEDED_MESSAGE),
    pending,
  );
  if (request.replaces) await stopSession(request.replaces);
  throwIfCancelled(null, signal);

  const { infoHash, fileIndex } = request;
  const { cacheDir } = getRuntime().config;
  const file = torrentService.getFile(infoHash, fileIndex);
  const probed = await mediaInfoService.get(infoHash, fileIndex);
  const encoder = await encoderForNewSession();
  throwIfCancelled(null, signal);
  const { info: media, videoIndex } = probed;
  const { tuning } = getRuntime();

  const video = media.video;
  if (!video)
    throw new AppError(ErrorCode.BadRequest, "This file has no video");
  const decision = decide({
    media,
    fileName: file.name,
    audioTrack: request.audioTrack,
    quality: request.quality,
    burnSubtitle: request.burnSubtitle,
    embeddedSubtitles: request.embeddedSubtitles,
    forceMode: request.forceMode,
    capabilities: request.capabilities,
    encoder,
  });
  refuseOnLowDisk(decision.mode, infoHash, fileIndex);

  let toneMapper: ToneMapper = "zscale";
  if (decision.mode === "transcode" && probed.hdrTransfer) {
    toneMapper = await getToneMapper();
    throwIfCancelled(null, signal);
  }

  // No await from this check until the session is registered, so
  // concurrent creates count each other.
  if (
    decision.mode === "transcode" &&
    countActiveTranscodes() >= tuning.maxTranscodes
  ) {
    throw new AppError(
      ErrorCode.ServiceUnavailable,
      "Too many videos are being converted right now",
    );
  }

  torrentService.focusFile(infoHash, fileIndex);
  torrentService.touch(infoHash);

  const id = randomUUID();
  const isHls = decision.mode !== "direct";
  const start = isHls
    ? Math.min(Math.max(0, request.start), Math.max(0, media.duration - 1))
    : 0;
  const subtitleStreams = isHls
    ? media.subtitleTracks
        .filter((t) => t.source === "embedded" && t.isText)
        .map((t) => Number(t.id.slice("embedded:".length)))
        .slice(0, MAX_SUBTITLE_OUTPUTS)
    : [];

  const session: Session = {
    id,
    playerId: request.playerId,
    infoHash,
    fileIndex,
    fileName: file.name,
    audioTrack: request.audioTrack,
    mode: decision.mode,
    playback: {
      id,
      mode: decision.mode,
      reason: decision.reason,
      url: isHls
        ? `/v1/playback/${id}/${PLAYLIST_FILE}`
        : `/v1/torrents/${infoHash}/files/${fileIndex}/stream`,
      offset: 0,
      duration: media.duration,
      output: decision.output,
      encoder: decision.encoder,
    },
    dir: isHls ? join(cachePaths(cacheDir).playback, id) : null,
    input: null,
    run: null,
    state: isHls ? "starting" : "running",
    offset: 0,
    requestedStart: start,
    lastSeenAt: Date.now(),
    position: null,
    paused: false,
    playlistMtimeMs: 0,
    producedUntil: null,
    subtitleStreams,
    error: null,
    stderr: [],
    creating: isHls,
    held: false,
    bytesPerSecond: media.duration > 0 ? file.size / media.duration : null,
    stopping: false,
  };
  // Registered before any await, so concurrent creates count it.
  sessions.set(id, session);
  log.info(
    {
      id,
      playerId: request.playerId,
      infoHash,
      fileIndex,
      mode: decision.mode,
      reason: decision.reason,
      start,
    },
    "Playback session created",
  );
  if (!session.dir) return session.playback;

  // ffmpeg's way in: a token URL for this one file, for this session only,
  // that never runs far ahead of the viewer.
  session.input = file.mintInternalUrl();
  session.input.allow(startAllowance(session));
  const job: SessionJob = {
    input: session.input.url,
    start,
    inputStartTime: probed.startTime,
    segmentSeconds: tuning.hlsSegmentSeconds,
    videoIndex,
    audioIndex: decision.audioTrack,
    audioCodec:
      media.audioTracks.find((t) => t.index === decision.audioTrack)?.codec ??
      null,
    audioCopy: decision.audioCopy,
    audioStart: null,
    video:
      decision.mode === "remux"
        ? { kind: "copy", codec: video.codec }
        : {
            kind: "encode",
            encoder,
            fps: video.fps,
            hdr: probed.hdrTransfer,
            toneMapper,
            deinterlace: probed.interlaced,
            width: video.width,
            height: video.height,
            scaleToHeight: decision.scaleToHeight,
            burnSubtitle: decision.burnSubtitle,
          },
    subtitleStreams,
  };

  try {
    // 503 when the video folder is gone (an unplugged drive).
    await ensureVideoFolder(cacheDir);
    await makeDirIn(session.dir);
    throwIfCancelled(session, signal);
    if (job.video.kind === "encode" && job.audioIndex !== null) {
      // Cut the audio at the first video frame (see SessionJob.audioStart).
      job.audioStart = await probeFirstFrameTime(
        job.input,
        start,
        videoIndex,
        signal,
      );
      throwIfCancelled(session, signal);
      if (job.audioStart === null) {
        log.warn({ id }, "Couldn't find the first video frame, audio not cut");
      }
    }
    await startFfmpeg(session, job, signal);
    session.state = session.held ? "throttled" : "running";

    const offset = await probeSessionOffset(
      join(session.dir, PLAYLIST_FILE),
      job.audioIndex !== null,
    );
    if (offset === null) {
      log.warn({ id }, "Couldn't read where the output starts, using start");
    }
    // A few ms below 0 (audio priming) is just 0.
    session.offset = Math.max(0, offset ?? start);
    session.playback.offset = session.offset;
    throwIfCancelled(session, signal);

    // Failed just after its first segment: no use to the player.
    const run = session.run;
    if (run?.exited && run.code !== 0) {
      log.error(
        { id, code: run.code, stderr: session.stderr },
        "ffmpeg failed right after the first segment",
      );
      throw startFailedError();
    }
  } catch (error) {
    await stopSession(id);
    throw error;
  }

  session.creating = false;
  session.lastSeenAt = Date.now();
  // Counted from the offset, known only now.
  session.playlistMtimeMs = 0;
  await refreshProduced(session);
  // It may have finished already, e.g. a start near the end.
  if (session.run && !isRunning(session.run)) {
    await settleExit(session, session.run);
  }
  log.info({ id, offset: session.offset }, "Playback session ready");
  return session.playback;
}

export const playbackService = {
  /**
   * Starts a session. Stops the player's other sessions and unfinished
   * starts first (those answer 409). `signal`: the request went away.
   */
  async create(
    request: CreatePlaybackRequest,
    signal?: AbortSignal,
  ): Promise<Playback> {
    ensureStarted();
    const pending: PendingStart = {
      playerId: request.playerId,
      abort: new AbortController(),
    };
    pendingStarts.add(pending);
    try {
      return await createSession(
        request,
        pending,
        signal
          ? AbortSignal.any([signal, pending.abort.signal])
          : pending.abort.signal,
      );
    } finally {
      pendingStarts.delete(pending);
    }
  },

  async heartbeat(
    id: string,
    beat: { position: number; paused: boolean; subtitle?: string | null },
  ): Promise<PlaybackStatus> {
    const session = getSession(id);
    markSeen(session);
    session.position = beat.position;
    session.paused = beat.paused;

    await refreshProduced(session);
    // Right away, so the answer says whether it's held back.
    await updateThrottle(session);

    emitHeartbeat({
      sessionId: session.id,
      infoHash: session.infoHash,
      fileIndex: session.fileIndex,
      fileName: session.fileName,
      position: beat.position,
      duration: session.playback.duration,
      paused: beat.paused,
      audioTrack: session.audioTrack,
      subtitle: beat.subtitle,
    });
    return statusOf(session);
  },

  /** Ends a session. Unknown ids are fine (already stopped). */
  stop(id: string): Promise<void> {
    return stopSession(id);
  },

  /**
   * The player closed: ends all its sessions and unfinished starts.
   * Unknown players are fine (nothing to do).
   */
  stopPlayer(playerId: string): Promise<void> {
    return stopPlayer(
      playerId,
      new AppError(ErrorCode.NotFound, STOPPED_MESSAGE),
    );
  },

  /**
   * The path of an HLS file to serve. `file` must already match
   * HLS_FILE_PATTERN; this checks it again anyway (it becomes a path).
   */
  hlsFile(id: string, file: string) {
    if (!HLS_FILE_PATTERN.test(file)) {
      throw new AppError(ErrorCode.NotFound, "No such file");
    }
    const session = getSession(id);
    if (!session.dir) {
      throw new AppError(
        ErrorCode.NotFound,
        "Direct playback has no HLS files",
      );
    }
    markSeen(session);
    const extension = file.slice(file.lastIndexOf(".") + 1);
    return {
      path: join(session.dir, file),
      contentType: CONTENT_TYPES[extension] ?? "application/octet-stream",
      isPlaylist: extension === "m3u8",
    };
  },

  /**
   * Blocking playlist reload (`index.m3u8?_HLS_msn=N`): resolves once
   * segment N is listed, the playlist ended, the session stopped or failed,
   * the client left (`signal`), or after blockingReloadLimitMs. The caller
   * then serves the playlist as it is.
   */
  async waitForSegment(id: string, msn: number, signal?: AbortSignal) {
    const session = getSession(id);
    if (!session.dir) return;
    const path = join(session.dir, PLAYLIST_FILE);
    const started = Date.now();

    for (;;) {
      const playlist: PlaylistSummary | null = await readFile(path, "utf8")
        .then(parsePlaylist)
        .catch(() => null);
      const done =
        signal?.aborted === true ||
        session.stopping ||
        session.state === "error" ||
        playlist?.ended === true ||
        (playlist !== null && hasSegment(playlist, msn)) ||
        Date.now() - started >= blockingReloadLimitMs(playlist);
      if (done) break;
      await sleep(BLOCKING_POLL_MS);
    }
    if (!session.stopping) markSeen(session);
  },

  async embeddedCues(
    id: string,
    n: number,
    range: { from: number; to: number },
  ): Promise<SubtitleCuesResponse> {
    const session = getSession(id);
    if (!session.dir || !session.subtitleStreams.includes(n)) {
      throw new AppError(
        ErrorCode.NotFound,
        "This session has no cues for that subtitle track",
      );
    }
    markSeen(session);
    await refreshProduced(session);

    const cues = await subtitlesService.readEmbeddedCues(
      join(session.dir, subtitleFile(n)),
    );
    return {
      cues: cuesBetween(cues, range.from, range.to),
      coveredFrom: session.offset,
      coveredTo: session.producedUntil ?? session.offset,
    };
  },

  /**
   * Called on every heartbeat (after it's handled). Returns an unsubscribe.
   * The library saves positions from here.
   */
  onHeartbeat(listener: (event: PlaybackHeartbeatEvent) => void): () => void {
    heartbeatListeners.add(listener);
    return () => {
      heartbeatListeners.delete(listener);
    };
  },

  /**
   * A session for this torrent is alive (it ends 60 s after its last
   * heartbeat). Such a torrent is never stopped to save resources.
   */
  isPlaying(infoHash: string): boolean {
    for (const session of sessions.values()) {
      if (session.infoHash === infoHash && !session.stopping) return true;
    }
    return false;
  },

  /** For tests and logs: the ffmpeg pid of a session, if it runs. */
  pid(id: string): number | null {
    const run = sessions.get(id)?.run ?? null;
    return isRunning(run) ? (run.child.pid ?? null) : null;
  },

  /** How many sessions exist (tests). */
  count(): number {
    return sessions.size;
  },

  /** Stops every session and start (tests). */
  async stopAll() {
    const reason = new AppError(ErrorCode.NotFound, STOPPED_MESSAGE);
    for (const pending of pendingStarts) pending.abort.abort(reason);
    await Promise.all([...sessions.keys()].map((id) => stopSession(id)));
  },

  /**
   * Shutdown: stops every session quickly (ffmpeg gets 1 s to exit before
   * SIGKILL), and the timers.
   */
  async shutdown() {
    if (idleTimer) clearInterval(idleTimer);
    idleTimer = null;
    if (throttleTimer) clearInterval(throttleTimer);
    throttleTimer = null;
    unsubscribeRemovals?.();
    unsubscribeRemovals = null;
    const reason = new AppError(ErrorCode.NotFound, STOPPED_MESSAGE);
    for (const pending of pendingStarts) pending.abort.abort(reason);
    await Promise.all(
      [...sessions.keys()].map((id) => stopSession(id, SHUTDOWN_GRACE_MS)),
    );
  },
};

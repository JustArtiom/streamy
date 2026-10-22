import {
  type ClientCapabilities,
  type CreatePlaybackRequest,
  ErrorCode,
  type MediaInfo,
  type Playback,
  type PlaybackMode,
  type PlaybackStatus,
  type Quality,
} from "../../../../shared/engine-api";
import {
  type HlsAdapter,
  type HlsSupport,
  realHls,
} from "@/components/player/hls-adapter";
import {
  clampSeekTarget,
  decideSeek,
  type FailureKind,
  mergeProducedUntil,
  movieTime,
  nextFallback,
} from "@/components/player/playback-logic";
import { type Selection, subtitleNeeds } from "@/components/player/tracks";
import {
  api,
  ApiRequestError,
  engineUrl,
  errorMessage,
  isAbortError,
  isApiError,
  isEngineUnavailable,
} from "@/lib/api";
import { getEngineStatus, subscribeEngineStatus } from "@/lib/engine-status";

export type EnginePhase =
  /** Nothing started yet. */
  | "idle"
  /** POST /playback in flight (ffmpeg starting, can take seconds). */
  | "preparing"
  /** A source is attached, waiting for the first frames. */
  | "loading"
  | "ready"
  /**
   * The playback engine stopped (it's being restarted). Everything waits
   * on the last frame; a new session starts where it was once it's back.
   */
  | "reconnecting"
  | "error";

export type EngineError = {
  /** "removed": the torrent is gone, offer Home instead of Retry. */
  kind: "playback" | "removed";
  title: string;
  message: string;
};

export type EngineSnapshot = {
  phase: EnginePhase;
  session: Playback | null;
  status: PlaybackStatus | null;
  /** HLS: movie time produced so far by this session. */
  producedUntil: number | null;
  selection: Selection;
  /** Where we're heading while a seek or a new session is under way. */
  pendingSeek: number | null;
  /** Play as soon as the video can (kept across session switches). */
  playIntent: boolean;
  /** The browser refused to start with sound: waiting for a click. */
  autoplayBlocked: boolean;
  error: EngineError | null;
  /** Set after a fallback (e.g. "remux" once direct failed); later sessions keep it. */
  forceMode: PlaybackMode | null;
  /** How HLS plays here: hls.js (MediaSource) or the browser itself (Safari). */
  hlsPlayer: "hls.js" | "native" | null;
};

export type EngineApi = Pick<
  typeof api,
  | "createPlayback"
  | "heartbeat"
  | "deletePlayback"
  | "deletePlayer"
  | "saveProgress"
>;

/** Whether the playback engine (the background process) is there. */
export type EngineConnection = {
  /** True while it's known to be stopped (starting, restarting, failed). */
  isDown: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

/** The real engine status, as the main process reports it. */
export const engineConnection: EngineConnection = {
  isDown: () => {
    const status = getEngineStatus();
    return status !== null && status.state !== "running";
  },
  subscribe: (listener) =>
    subscribeEngineStatus(() => {
      listener();
    }),
};

export type EngineOptions = {
  infoHash: string;
  fileIndex: number;
  /** null = ffprobe isn't available: play the file as it is (see `raw`). */
  media: MediaInfo | null;
  capabilities: ClientCapabilities;
  selection: Selection;
  /** Movie time to begin at (resume point or 0). */
  start: number;
  /**
   * The engine can't convert (ffmpeg isn't working): skip sessions and
   * point the video straight at the file's stream URL.
   */
  raw?: boolean;
  api?: EngineApi;
  hls?: HlsSupport;
  connection?: EngineConnection;
  /**
   * Opens the torrent again in the engine (it stops when idle, and a
   * restarted engine has none open). Rejects when it can't be.
   */
  reopenTorrent?: () => Promise<unknown>;
  /** Short messages for the viewer ("Switched to converted playback"). */
  onNotice?: (message: string) => void;
  /** The library saved a position (so lists showing it can refresh). */
  onProgressSaved?: () => void;
  heartbeatMs?: number;
  /** Far seeks wait this long, so a burst of key presses starts one ffmpeg. */
  seekDebounceMs?: number;
  /** How long to wait before trying again when the engine didn't answer. */
  reconnectRetryMs?: number;
  /** How long to wait before asking again for a torrent not ready yet (409). */
  notReadyRetryMs?: number;
};

const HEARTBEAT_MS = 5000;
const SEEK_DEBOUNCE_MS = 300;
const RECONNECT_RETRY_MS = 3000;
/**
 * A torrent opened again (after a restart, or when it stopped while idle)
 * may need a moment before its file list is known (409). Asked again this
 * often, for up to two minutes, while "Preparing video…" shows.
 */
const NOT_READY_RETRY_MS = 1000;
const MAX_NOT_READY_TRIES = 120;
/**
 * Tries without an answer while the engine is said to be running (it may
 * be stuck rather than restarting) before showing the error.
 */
const MAX_RECONNECT_TRIES = 3;
/**
 * Failed attempts (one per heartbeat) at getting a new id for a direct
 * session the engine forgot, before leaving it: the position is still saved
 * when the player closes.
 */
const MAX_RENEW_FAILURES = 3;
// HTMLMediaElement / MediaError constants (not every test DOM defines them).
const HAVE_METADATA = 1;
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;

/**
 * Runs playback sessions for one file on one <video> element:
 * creates them (POST /playback), plays them (direct / hls.js / native HLS),
 * seeks on the movie timeline, switches sessions for far seeks and track
 * changes, falls back when the browser can't play something, keeps the
 * session alive with heartbeats and stops it when the player goes away.
 * It also waits out engine restarts, and saves the position in the library
 * when the player closes or the movie ends.
 *
 * Plain class, no React: the player subscribes to snapshots
 * (useSyncExternalStore) and calls the methods.
 */
export class PlaybackEngine {
  private readonly options: EngineOptions;
  private readonly api: EngineApi;
  private readonly hlsSupport: HlsSupport;
  private readonly connection: EngineConnection;
  private readonly raw: boolean;

  private snapshot: EngineSnapshot;
  private readonly listeners = new Set<() => void>();

  private video: HTMLVideoElement | null = null;
  private mounted = false;
  private cleanups: (() => void)[] = [];
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private seekTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private notReadyTimer: ReturnType<typeof setTimeout> | null = null;
  /** 409s in a row for the current start (see MAX_NOT_READY_TRIES). */
  private notReadyTries = 0;

  /**
   * Sent with every start. The engine stops this player's other sessions
   * when a new one starts, including a start still in progress: aborting
   * the fetch doesn't reach it through Electron's protocol handler. A new
   * one for each mount.
   */
  private playerId = "";
  /** A start was sent under playerId: something may need stopping on the way out. */
  private playerUsed = false;

  private hls: HlsAdapter | null = null;
  /** Movie time where the playlist hls.js has loaded ends. */
  private hlsEdge: number | null = null;
  private inflight: AbortController | null = null;
  /** Bumped by every session start; late answers from older ones are dropped. */
  private generation = 0;
  /** Movie time used when there's no session to ask (before the first one). */
  private resumeAt: number;
  /** Session time to jump to once the source has metadata (direct, native HLS). */
  private pendingStartTime: number | null = null;
  private recovered = false;
  private networkRestarts = 0;
  /** The engine no longer knows this session (deleted on pagehide, idle, restarted). */
  private sessionGone = false;
  /** Direct play: a new id for a forgotten session is on its way. */
  private renewing = false;
  /** Failed attempts at that since the last session start. */
  private renewFailures = 0;
  /** Between pagehide and pageshow: nothing new should start. */
  private pageHidden = false;
  /** Attempts since the engine last answered (see MAX_RECONNECT_TRIES). */
  private reconnectTries = 0;
  /** Something played, so there's a position worth saving. */
  private played = false;
  /** The position was saved on the way out (pagehide, then unmount). */
  private finalSaved = false;
  /** The last position saved here (the end of the movie, say). */
  private lastSaved: number | null = null;

  constructor(options: EngineOptions) {
    // No side effects here: React may build an instance it then throws away.
    this.options = options;
    this.api = options.api ?? api;
    this.hlsSupport = options.hls ?? realHls;
    this.connection = options.connection ?? engineConnection;
    this.raw = options.raw ?? false;
    this.resumeAt = options.start;
    this.snapshot = {
      phase: "idle",
      session: null,
      status: null,
      producedUntil: null,
      selection: options.selection,
      pendingSeek: null,
      playIntent: true,
      autoplayBlocked: false,
      error: null,
      forceMode: null,
      hlsPlayer: null,
    };
  }

  // ─── Store ────────────────────────────────────────────────────────────────

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<EngineSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  mount(video: HTMLVideoElement) {
    if (this.mounted) return;
    this.mounted = true;
    this.video = video;
    this.finalSaved = false;
    // A fresh id: the previous mount's "stop this player" may still be on
    // its way (React StrictMode mounts twice).
    this.playerId = crypto.randomUUID();
    this.playerUsed = false;

    this.listen(video, "loadedmetadata", this.onLoadedMetadata);
    this.listen(video, "canplay", this.onCanPlay);
    this.listen(video, "seeked", this.onCanPlay);
    this.listen(video, "playing", this.onPlaying);
    this.listen(video, "play", this.onPlay);
    this.listen(video, "pause", this.onPause);
    this.listen(video, "ended", this.onEnded);
    this.listen(video, "error", this.onVideoError);
    this.listen(window, "pagehide", this.onPageHide);
    this.listen(window, "pageshow", this.onPageShow);
    this.cleanups.push(this.connection.subscribe(this.onConnectionChange));

    // Started a tick later: React StrictMode mounts, unmounts and mounts again
    // straight away in development. The first timer is cleared before it
    // fires, so only one session is ever created.
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      if (this.connection.isDown()) this.enterReconnecting();
      else this.begin();
    }, 0);
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, this.options.heartbeatMs ?? HEARTBEAT_MS);
  }

  unmount() {
    if (!this.mounted) return;
    this.resumeAt = this.getMovieTime();
    this.saveFinalPosition();
    this.mounted = false;

    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.seekTimer) clearTimeout(this.seekTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.notReadyTimer) clearTimeout(this.notReadyTimer);
    this.startTimer = this.seekTimer = this.heartbeatTimer = null;
    this.reconnectTimer = this.notReadyTimer = null;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];

    // Abort a session being created (for the UI: the engine hears about it
    // through stopPlayer()); if it still answers, the generation check
    // deletes it.
    this.generation += 1;
    this.inflight?.abort();
    this.inflight = null;

    this.destroyHls();
    this.detachSource();
    this.deleteSession();
    this.stopPlayer();
    this.video = null;
    this.update({
      phase: "idle",
      session: null,
      status: null,
      producedUntil: null,
      pendingSeek: null,
    });
  }

  private listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.cleanups.push(() => {
      target.removeEventListener(type, listener);
    });
  }

  private begin() {
    if (this.raw) {
      this.attach(this.rawPlayback(), this.resumeAt);
    } else {
      void this.startSession(this.resumeAt);
    }
  }

  // ─── Public controls ──────────────────────────────────────────────────────

  /** The current position on the movie's timeline. */
  getMovieTime = () => {
    const { pendingSeek, session } = this.snapshot;
    if (pendingSeek !== null) return pendingSeek;
    if (!session || !this.video) return this.resumeAt;
    return movieTime(session.offset, this.video.currentTime);
  };

  /** The movie's length (from ffprobe, else what the video element says). */
  getDuration() {
    const fromMedia = this.options.media?.duration;
    if (fromMedia && Number.isFinite(fromMedia)) return fromMedia;
    const fromVideo = this.video?.duration ?? NaN;
    return Number.isFinite(fromVideo) ? fromVideo : 0;
  }

  /** Playing, or about to (what the play/pause button shows). */
  isPlaying() {
    const { phase, playIntent } = this.snapshot;
    if (phase === "ready" && this.video) {
      return !this.video.paused && !this.video.ended;
    }
    return playIntent;
  }

  /** For media keys, which say "play" or "pause" rather than "toggle". */
  play() {
    if (!this.isPlaying()) this.togglePlay();
  }

  pause() {
    if (this.isPlaying()) this.togglePlay();
  }

  seek(target: number) {
    const t = clampSeekTarget(target, this.getDuration());
    const { phase, session, producedUntil } = this.snapshot;

    if (phase === "idle" || phase === "error" || phase === "reconnecting") {
      // Nothing playing: remember it for Retry / the first start / when
      // the engine is back.
      this.resumeAt = t;
      if (phase !== "idle") this.update({ pendingSeek: t });
      return;
    }

    if (
      !this.raw &&
      (phase === "preparing" ||
        !session ||
        (phase === "loading" && session.mode !== "direct"))
    ) {
      // A session is on its way: aim the next one at the new target instead.
      this.scheduleSession(t);
      return;
    }
    if (!session) return;

    const decision = decideSeek({
      target: t,
      duration: this.getDuration(),
      mode: session.mode,
      offset: session.offset,
      // hls.js can only seek inside the playlist it has (the engine's count
      // can be a little ahead of it).
      seekableUntil: this.hls ? this.hlsEdge : producedUntil,
    });

    if (decision.kind === "session") {
      this.scheduleSession(t);
      return;
    }

    this.cancelScheduledSeek();
    const video = this.video;
    if (!video) return;
    if (phase === "loading") {
      // Direct file still loading: jump now if it knows its length, else
      // as soon as it does. "ready" follows the seek.
      if (video.readyState >= HAVE_METADATA) {
        video.currentTime = decision.currentTime;
      } else {
        this.pendingStartTime = decision.currentTime;
      }
      this.update({ pendingSeek: t });
      return;
    }
    video.currentTime = decision.currentTime;
    if (this.snapshot.pendingSeek !== null) this.update({ pendingSeek: null });
  }

  togglePlay() {
    const video = this.video;
    if (!video) return;
    const { phase, playIntent } = this.snapshot;
    if (phase === "ready" && video.ended) {
      // Play again from the movie's start, which may be before this session.
      this.update({ playIntent: true, autoplayBlocked: false });
      if (this.snapshot.session?.offset === 0) {
        video.currentTime = 0;
        this.playVideo();
      } else {
        void this.startSession(0);
      }
      return;
    }
    if (phase === "ready") {
      if (video.paused) {
        this.update({ playIntent: true, autoplayBlocked: false });
        this.playVideo();
      } else {
        video.pause();
      }
      return;
    }
    // No playable source yet: remember the wish for when there is.
    this.update({ playIntent: !playIntent, autoplayBlocked: false });
  }

  setQuality(quality: Quality) {
    if (quality === this.snapshot.selection.quality) return;
    this.select({ quality }, true);
  }

  setAudioTrack(audioTrack: number | null) {
    // null means "the file's default", so picking the default is no change.
    const effective = (index: number | null) => index ?? this.defaultAudio();
    if (
      effective(audioTrack) === effective(this.snapshot.selection.audioTrack)
    ) {
      return;
    }
    this.select({ audioTrack }, true);
  }

  private defaultAudio() {
    const tracks = this.options.media?.audioTracks ?? [];
    return (
      (tracks.find((track) => track.isDefault) ?? tracks[0])?.index ?? null
    );
  }

  setSubtitle(subtitleId: string | null) {
    const { selection, session } = this.snapshot;
    if (subtitleId === selection.subtitleId) return;
    const tracks = this.options.media?.subtitleTracks ?? [];
    const before = subtitleNeeds(tracks, selection.subtitleId);
    const after = subtitleNeeds(tracks, subtitleId);
    // Burned-in subtitles live in the video itself: changing them (also
    // turning them off) needs a new session. Embedded text cues only come
    // from ffmpeg, so a direct session can't show them. Turning text
    // subtitles off never needs a switch.
    // While a session is being created, its request used the old choice:
    // any change in what the engine must do means asking again.
    const changed =
      after.burnSubtitle !== before.burnSubtitle ||
      after.embeddedSubtitles !== before.embeddedSubtitles;
    const needsSession =
      after.burnSubtitle !== before.burnSubtitle ||
      (after.embeddedSubtitles && session?.mode === "direct") ||
      (this.snapshot.phase === "preparing" && changed);
    this.select({ subtitleId }, needsSession);
  }

  retry() {
    this.recovered = false;
    this.networkRestarts = 0;
    this.reconnectTries = 0;
    // (Each start also gets its own two minutes of 409s: see startSession.)
    if (this.raw) {
      this.attach(this.rawPlayback(), this.getMovieTime());
    } else {
      void this.startSession(this.getMovieTime());
    }
  }

  private select(patch: Partial<Selection>, needsSession: boolean) {
    const at = this.getMovieTime();
    this.update({ selection: { ...this.snapshot.selection, ...patch } });
    // While reconnecting, the session that follows uses the new choice.
    if (
      needsSession &&
      !this.raw &&
      this.mounted &&
      this.snapshot.phase !== "reconnecting"
    ) {
      this.cancelScheduledSeek();
      void this.startSession(at);
    }
  }

  // ─── Sessions ─────────────────────────────────────────────────────────────

  private scheduleSession(start: number) {
    const { phase } = this.snapshot;
    if (phase === "preparing" || phase === "loading") {
      // The session on its way is for the old target: drop it now, or it
      // would briefly play from there before the new one replaces it. A
      // late answer to its POST is deleted (generation check).
      this.generation += 1;
      this.inflight?.abort();
      this.inflight = null;
      this.update({ phase: "preparing" });
      this.freeze();
    }
    this.update({ pendingSeek: start });
    if (this.seekTimer) clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null;
      void this.startSession(start);
    }, this.options.seekDebounceMs ?? SEEK_DEBOUNCE_MS);
  }

  private cancelScheduledSeek() {
    if (!this.seekTimer) return;
    clearTimeout(this.seekTimer);
    this.seekTimer = null;
  }

  private async startSession(start: number, attempt: StartAttempt = {}) {
    if (!this.mounted) return;
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;
    const generation = ++this.generation;
    this.resumeAt = start;
    // Every start the viewer (or a fallback) asks for gets the full two
    // minutes of 409s, not what an earlier start left of them.
    if (!attempt.notReady) this.notReadyTries = 0;
    if (this.notReadyTimer) clearTimeout(this.notReadyTimer);
    this.notReadyTimer = null;

    // Phase first, then pause: the "pause" event must not read as the
    // viewer pausing (we keep their play/pause wish across the switch).
    this.update({
      phase: "preparing",
      pendingSeek: start,
      error: null,
      autoplayBlocked: false,
    });
    this.freeze();

    try {
      const playback = await this.create(
        this.playbackRequest(start),
        controller.signal,
      );
      // unmount() bumps the generation too.
      if (generation !== this.generation) {
        // Superseded while the engine was busy creating it.
        void this.api.deletePlayback(playback.id);
        return;
      }
      this.inflight = null;
      this.attach(playback, start);
    } catch (error) {
      if (isAbortError(error) || generation !== this.generation) return;
      this.inflight = null;
      if (this.engineMissing(error)) {
        this.enterReconnecting();
        return;
      }
      if (isApiError(error, 409) && this.notReadyTries < MAX_NOT_READY_TRIES) {
        // The file list isn't known yet, or the data on disk is being
        // checked: ask again in a moment (any newer start supersedes this).
        this.notReadyTries += 1;
        this.notReadyTimer = setTimeout(() => {
          this.notReadyTimer = null;
          if (generation === this.generation) {
            void this.startSession(start, { ...attempt, notReady: true });
          }
        }, this.options.notReadyRetryMs ?? NOT_READY_RETRY_MS);
        return;
      }
      const { reopenTorrent } = this.options;
      if (isApiError(error, 404) && !attempt.reopened && reopenTorrent) {
        // The torrent isn't open in the engine (it stopped when idle, or the
        // engine restarted): open it again, then try once more.
        try {
          await reopenTorrent();
        } catch (reopenError) {
          if (generation !== this.generation) return;
          this.fail(startError(reopenError));
          return;
        }
        if (generation === this.generation) {
          void this.startSession(start, { ...attempt, reopened: true });
        }
        return;
      }
      if (isConversionFailure(error)) {
        // ffmpeg stopped before its first segment: like a remux the browser
        // can't play, so convert it instead (or give up after converting).
        console.warn("Playback couldn't start:", error);
        if (!this.convertInstead(start)) {
          this.fail(playbackError("media", this.raw, true));
        }
        return;
      }
      this.fail(startError(error));
    }
  }

  /**
   * After ffmpeg failed to start: one step down the fallback ladder (to
   * transcode). False when there's nothing left to try.
   */
  private convertInstead(start: number) {
    const { forceMode } = this.snapshot;
    const step = nextFallback({
      // Only remux and transcode run ffmpeg. Without a forced mode the
      // engine picked one: treat it as remux (had it been a transcode, the
      // forced one fails the same way, and then this gives up).
      mode: forceMode ?? "remux",
      kind: "media",
      forceMode,
      // Nothing to recover: no hls.js runs for a session that never started.
      recovered: true,
      usingHlsJs: false,
      networkRestarts: 0,
      canConvert: !this.raw,
    });
    if (step.action !== "restart") return false;
    this.update({ forceMode: step.forceMode });
    this.options.onNotice?.("Switched to converted playback");
    void this.startSession(start);
    return true;
  }

  /** What to ask the engine for: the current choices, starting at `start`. */
  private playbackRequest(start: number): CreatePlaybackRequest {
    const { selection, forceMode, session } = this.snapshot;
    const tracks = this.options.media?.subtitleTracks ?? [];
    return {
      infoHash: this.options.infoHash,
      fileIndex: this.options.fileIndex,
      start,
      audioTrack: selection.audioTrack,
      quality: selection.quality,
      ...subtitleNeeds(tracks, selection.subtitleId),
      forceMode,
      // The engine stops the old session first (its ffmpeg is done for).
      replaces: session && !this.sessionGone ? session.id : null,
      playerId: this.playerId,
      capabilities: this.options.capabilities,
    };
  }

  private create(request: CreatePlaybackRequest, signal?: AbortSignal) {
    this.playerUsed = true;
    return this.api.createPlayback(request, signal);
  }

  /** Stops whatever the engine still runs for this player, starts included. */
  private stopPlayer() {
    if (!this.playerUsed) return;
    this.playerUsed = false;
    void this.api.deletePlayer(this.playerId);
  }

  /** Stop the current source without losing its last frame. */
  private freeze() {
    this.hls?.stopLoad();
    const video = this.video;
    if (video && !video.paused) video.pause();
  }

  private attach(playback: Playback, start: number) {
    const video = this.video;
    if (!video) return;
    this.destroyHls();
    this.recovered = false;
    this.sessionGone = false;
    this.renewFailures = 0;
    this.pendingStartTime = null;
    this.update({
      session: playback,
      phase: "loading",
      status: null,
      producedUntil: null,
      pendingSeek: start,
      hlsPlayer: null,
    });

    const url = engineUrl(playback.url);
    if (playback.mode === "direct") {
      this.pendingStartTime = start > 0.25 ? start : null;
      video.src = url;
      return;
    }

    // hls.js plays session time 0 at the session's offset, so start there.
    const startPosition = Math.max(0, start - playback.offset);
    if (this.hlsSupport.isSupported()) {
      const hls = this.hlsSupport.create(startPosition);
      this.hls = hls;
      hls.onPlaylist((totalDuration) => {
        if (this.hls !== hls) return;
        this.hlsEdge = playback.offset + totalDuration;
        const producedUntil = mergeProducedUntil(
          this.snapshot.producedUntil,
          playback.offset + totalDuration,
        );
        if (producedUntil !== this.snapshot.producedUntil) {
          this.update({ producedUntil });
        }
      });
      hls.onFatalError((kind) => {
        if (this.hls === hls) this.handleFailure(kind);
      });
      hls.load(url, video);
      this.update({ hlsPlayer: "hls.js" });
      return;
    }

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      // A browser without MediaSource that plays HLS by itself.
      this.pendingStartTime = startPosition > 0.25 ? startPosition : null;
      video.src = url;
      this.update({ hlsPlayer: "native" });
      return;
    }

    this.fail({
      kind: "playback",
      title: "Converted video can't play here",
      message:
        "This system supports neither Media Source Extensions nor HLS, which converted videos need.",
    });
  }

  private rawPlayback(): Playback {
    const { infoHash, fileIndex, media } = this.options;
    return {
      id: "",
      mode: "direct",
      reason:
        "Playing the file as it is (Streamy can't convert video: ffmpeg isn't working)",
      url: `/v1/torrents/${infoHash}/files/${fileIndex}/stream`,
      offset: 0,
      duration: media?.duration ?? 0,
      output: { videoCodec: "?", audioCodec: "?", width: 0, height: 0 },
      encoder: null,
    };
  }

  private destroyHls() {
    this.hls?.destroy();
    this.hls = null;
    this.hlsEdge = null;
  }

  private detachSource() {
    const video = this.video;
    if (!video?.getAttribute("src")) return;
    // Stops the browser's Range requests for the old file.
    video.removeAttribute("src");
    video.load();
  }

  private deleteSession() {
    const session = this.snapshot.session;
    if (session && !this.raw && !this.sessionGone) {
      void this.api.deletePlayback(session.id);
    }
    this.sessionGone = true;
  }

  private playVideo() {
    const video = this.video;
    if (!video) return;
    video.play().catch((error: unknown) => {
      // Autoplay with sound refused: show a big play button instead.
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.update({ playIntent: false, autoplayBlocked: true });
      }
      // AbortError = a new source replaced this one; nothing to do.
    });
  }

  // ─── Video events ─────────────────────────────────────────────────────────

  private onLoadedMetadata = () => {
    const video = this.video;
    if (!video || this.pendingStartTime === null) return;
    video.currentTime = this.pendingStartTime;
    this.pendingStartTime = null;
  };

  private onCanPlay = () => {
    const video = this.video;
    if (!video || this.snapshot.phase !== "loading") return;
    if (video.seeking || this.pendingStartTime !== null) return;
    this.played = true;
    this.update({ phase: "ready", pendingSeek: null });
    if (this.snapshot.playIntent) this.playVideo();
  };

  private onPlaying = () => {
    // It plays, so the network was fine after all.
    this.networkRestarts = 0;
    this.reconnectTries = 0;
  };

  private onPlay = () => {
    if (this.snapshot.phase === "ready" && !this.snapshot.playIntent) {
      this.update({ playIntent: true, autoplayBlocked: false });
    }
  };

  private onPause = () => {
    if (this.snapshot.phase === "ready" && this.snapshot.playIntent) {
      this.update({ playIntent: false });
    }
  };

  private onEnded = () => {
    // Saved now (not only on the way out), so the watched rule applies
    // even if Streamy is quit right after the credits.
    if (this.snapshot.phase === "ready") this.saveProgress(false);
  };

  private onVideoError = () => {
    // hls.js reports its own errors (and recovers some); this is for direct
    // and native HLS.
    const code = this.video?.error?.code;
    if (this.hls || !code || code === MEDIA_ERR_ABORTED) return;
    this.handleFailure(code === MEDIA_ERR_NETWORK ? "network" : "media");
  };

  private onPageHide = () => {
    // The window is closing (or reloading): save where we are and stop
    // ffmpeg right away, with requests that outlive the page (keepalive).
    this.pageHidden = true;
    this.saveFinalPosition();
    this.deleteSession();
    this.stopPlayer();
  };

  private onPageShow = (event: Event) => {
    this.pageHidden = false;
    // Back from the back/forward cache: the session was deleted on pagehide
    // (a direct one gets a new id with the next heartbeat).
    const persisted = "persisted" in event && event.persisted === true;
    if (!persisted) return;
    this.finalSaved = false;
    // The old id was told to stop on pagehide.
    this.playerId = crypto.randomUUID();
    const { session, phase } = this.snapshot;
    if (!session || this.raw) return;
    if (session.mode !== "direct" && phase !== "error") {
      void this.startSession(this.getMovieTime());
    }
  };

  // ─── Engine restarts ──────────────────────────────────────────────────────

  /** The engine wasn't there to answer (rather than answering "no"). */
  private engineMissing(error: unknown) {
    return isEngineUnavailable(error) || this.connection.isDown();
  }

  private onConnectionChange = () => {
    if (!this.mounted) return;
    const { phase } = this.snapshot;
    if (this.connection.isDown()) {
      // Before the first start, begin() checks again when it runs. An error
      // on screen may well have been the engine stopping: say so instead,
      // and try again when it's back.
      if (phase === "idle" || phase === "reconnecting") return;
      if (phase === "error" && this.snapshot.error?.kind === "removed") return;
      this.enterReconnecting();
    } else if (phase === "reconnecting") {
      this.reconnect();
    }
  };

  /**
   * The engine stopped: every session and open torrent is gone with it.
   * Keep the last frame and the place, and wait until it's back.
   */
  private enterReconnecting() {
    if (!this.mounted) return;
    // getMovieTime() is the target of a seek or session on its way, or the
    // place an error was shown at.
    this.resumeAt = this.getMovieTime();
    this.cancelScheduledSeek();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.generation += 1;
    this.inflight?.abort();
    this.inflight = null;
    // Nothing to delete or replace: the engine forgot it.
    this.sessionGone = true;
    this.update({
      phase: "reconnecting",
      pendingSeek: this.resumeAt,
      error: null,
      autoplayBlocked: false,
    });
    this.freeze();

    // Said to be running, yet it didn't answer: it may be stuck rather than
    // restarting, so no status change will come. Try again in a while, a
    // few times, then show the error.
    if (!this.connection.isDown()) {
      this.reconnectTries += 1;
      if (this.reconnectTries > MAX_RECONNECT_TRIES) {
        this.reconnectTries = 0;
        this.fail(playbackError("network", this.raw));
        return;
      }
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.snapshot.phase === "reconnecting") this.reconnect();
      }, this.options.reconnectRetryMs ?? RECONNECT_RETRY_MS);
    }
  }

  /** The engine is back: start again where we were. */
  private reconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.recovered = false;
    this.networkRestarts = 0;
    if (this.raw) {
      // No session to ask for: the stream needs the torrent open first.
      const generation = ++this.generation;
      this.update({ phase: "preparing" });
      void (this.options.reopenTorrent?.() ?? Promise.resolve()).then(
        () => {
          if (generation === this.generation && this.mounted) {
            this.attach(this.rawPlayback(), this.resumeAt);
          }
        },
        (error: unknown) => {
          if (generation !== this.generation || !this.mounted) return;
          if (this.engineMissing(error)) this.enterReconnecting();
          else this.fail(startError(error));
        },
      );
      return;
    }
    // A 404 (the torrent isn't open yet) opens it, then asks again.
    void this.startSession(this.resumeAt);
  }

  // ─── Failures ─────────────────────────────────────────────────────────────

  private handleFailure(
    kind: FailureKind,
    options: { skipRecover?: boolean; message?: string } = {},
  ) {
    const { session, phase } = this.snapshot;
    // Only the source that's playing (or about to) counts: an old one acting
    // up while the next session is created must not restart anything.
    if (!session || (phase !== "loading" && phase !== "ready")) return;

    // The engine stopped: nothing wrong with the video, it just has to wait.
    if (kind === "network" && this.connection.isDown()) {
      this.enterReconnecting();
      return;
    }

    const step = nextFallback({
      mode: session.mode,
      kind,
      forceMode: this.snapshot.forceMode,
      recovered: this.recovered || options.skipRecover === true,
      usingHlsJs: this.hls !== null,
      networkRestarts: this.networkRestarts,
      canConvert: !this.raw,
    });

    if (step.action === "recover") {
      this.recovered = true;
      this.hls?.recoverMediaError();
      return;
    }

    if (step.action === "restart") {
      if (kind === "network") this.networkRestarts += 1;
      if (step.forceMode !== this.snapshot.forceMode) {
        this.update({ forceMode: step.forceMode });
        this.options.onNotice?.("Switched to converted playback");
      }
      void this.startSession(this.getMovieTime());
      return;
    }

    if (options.message) {
      // ffmpeg's own words ("ffmpeg stopped unexpectedly: …"): for the
      // console, not the viewer.
      console.warn("Playback failed:", options.message);
    }
    this.fail(playbackError(kind, this.raw, options.message !== undefined));
  }

  private fail(error: EngineError) {
    // Read the position before destroying hls.js: detaching resets the
    // video to 0. Kept as pendingSeek, so Retry, a track change from the
    // error screen and the saved position all use it.
    this.resumeAt = this.getMovieTime();
    this.destroyHls();
    this.deleteSession();
    this.update({ phase: "error", error, pendingSeek: this.resumeAt });
  }

  // ─── Heartbeat and the library ────────────────────────────────────────────

  private async sendHeartbeat() {
    const { session, phase, selection } = this.snapshot;
    const video = this.video;
    if (!session || !video || this.raw) return;
    if (phase !== "ready" && phase !== "loading") return;
    if (this.sessionGone) {
      // Direct play goes on without its session, but heartbeats are what
      // save the position: keep asking for a new id.
      if (session.mode === "direct") void this.renewDirectSession(session);
      return;
    }

    try {
      const status = await this.api.heartbeat(session.id, {
        position: this.getMovieTime(),
        paused: video.paused,
        // Saved with the position, so resuming brings it back.
        subtitle: selection.subtitleId,
      });
      if (this.snapshot.session !== session) return;
      this.update({
        status,
        producedUntil:
          session.mode === "direct"
            ? null
            : mergeProducedUntil(
                this.snapshot.producedUntil,
                status.producedUntil,
              ),
      });
      if (status.state === "error" && session.mode !== "direct") {
        // ffmpeg died: the playlist will never grow again.
        this.handleFailure("media", {
          skipRecover: true,
          message: status.error ?? undefined,
        });
      }
    } catch (error) {
      if (this.snapshot.session !== session) return;
      // A stopped engine shows up as a status change; nothing to do here.
      if (isApiError(error, 404)) {
        // The engine forgot this session (idle too long, e.g. a sleeping
        // laptop, or it restarted). Direct play only needs a new id; HLS
        // gets a fresh session here.
        this.sessionGone = true;
        if (session.mode === "direct") {
          void this.renewDirectSession(session);
        } else if (this.snapshot.phase === "ready") {
          void this.startSession(this.getMovieTime());
        }
      }
    }
  }

  /**
   * A new session for a direct one the engine forgot, so heartbeats (and
   * the saved position) carry on. The browser reads the same stream URL
   * either way, so the video isn't touched: no attach().
   */
  private async renewDirectSession(gone: Playback) {
    if (this.renewing || this.pageHidden) return;
    if (this.renewFailures >= MAX_RENEW_FAILURES) return;
    this.renewing = true;
    const generation = this.generation;
    // Nothing else replaced it meanwhile (a track change, a fallback…).
    const current = () =>
      this.mounted &&
      generation === this.generation &&
      this.snapshot.session === gone;
    const request: CreatePlaybackRequest = {
      ...this.playbackRequest(this.getMovieTime()),
      // The same file as it is, never a conversion behind the viewer's back.
      forceMode: "direct",
      replaces: null,
    };
    try {
      let renewed: Playback;
      try {
        renewed = await this.create(request);
      } catch (error) {
        // The torrent stopped too while nothing used it: open it again
        // (the stream needs it as well), then ask once more.
        const { reopenTorrent } = this.options;
        if (!isApiError(error, 404) || !reopenTorrent || !current()) {
          throw error;
        }
        await reopenTorrent();
        if (!current()) return;
        renewed = await this.create(request);
      }
      if (!current()) {
        void this.api.deletePlayback(renewed.id);
        return;
      }
      if (renewed.mode !== "direct" || renewed.url !== gone.url) {
        // Not the stream that's playing: no use, and asking again won't help.
        void this.api.deletePlayback(renewed.id);
        this.renewFailures = MAX_RENEW_FAILURES;
        return;
      }
      this.sessionGone = false;
      this.renewFailures = 0;
      this.update({ session: renewed });
    } catch (error) {
      if (!current()) return;
      // Tried again with the next heartbeats, a few times. A stopped engine
      // shows up as a status change instead (reconnecting).
      this.renewFailures += 1;
      console.warn("Couldn't renew the playback session:", error);
    } finally {
      this.renewing = false;
    }
  }

  /**
   * Saves where the viewer is in the library: the heartbeats don't cover
   * the last few seconds, and direct play may pause for long stretches.
   * Best effort: the library may not know this file (404) or the engine
   * may be gone, and neither is worth bothering the viewer about.
   */
  private saveProgress(keepalive: boolean) {
    const duration = this.getDuration();
    const position =
      duration > 0
        ? Math.min(this.getMovieTime(), duration)
        : this.getMovieTime();
    const { selection } = this.snapshot;
    this.lastSaved = position;
    this.api
      .saveProgress(
        this.options.infoHash,
        this.options.fileIndex,
        {
          position,
          duration: duration > 0 ? duration : null,
          audioTrack: selection.audioTrack,
          subtitle: selection.subtitleId,
        },
        { keepalive },
      )
      .then(
        () => {
          this.options.onProgressSaved?.();
        },
        () => undefined,
      );
  }

  /** Once on the way out (pagehide, then unmount, mustn't save twice). */
  private saveFinalPosition() {
    if (!this.played || this.finalSaved) return;
    this.finalSaved = true;
    // Nothing new since the end of the movie was saved.
    if (
      this.lastSaved !== null &&
      Math.abs(this.getMovieTime() - this.lastSaved) < 1
    ) {
      return;
    }
    this.saveProgress(true);
  }
}

type StartAttempt = {
  /** The torrent was just opened again after a 404: don't loop. */
  reopened?: boolean;
  /** Asking again after a 409: the same start, so the same two minutes. */
  notReady?: boolean;
};

/**
 * The engine answered a start with its own failure (ffmpeg stopped before
 * the first segment: 500 INTERNAL), not "unavailable right now" (503: busy,
 * timed out, no ffmpeg) or a stopped engine (the proxy's 502/503).
 */
function isConversionFailure(error: unknown) {
  return (
    isApiError(error) &&
    !isEngineUnavailable(error) &&
    error.status >= 500 &&
    error.code !== ErrorCode.ServiceUnavailable
  );
}

function startError(error: unknown): EngineError {
  if (error instanceof ApiRequestError) {
    if (error.status === 404) {
      return {
        kind: "removed",
        title: "This torrent was removed",
        message: "It isn't in Streamy anymore, so it can't be played.",
      };
    }
    if (error.status === 0) {
      return {
        kind: "playback",
        title: "Can't reach the playback engine",
        message: errorMessage(error),
      };
    }
  }
  return {
    kind: "playback",
    title: "Couldn't start the video",
    message: errorMessage(error),
  };
}

function playbackError(
  kind: FailureKind,
  raw: boolean,
  conversionFailed = false,
): EngineError {
  if (raw) {
    return {
      kind: "playback",
      title: "This video can't be played",
      message:
        "It can't be played as it is, and Streamy can't convert it because ffmpeg isn't working.",
    };
  }
  if (kind === "network") {
    return {
      kind: "playback",
      title: "Lost the video stream",
      message:
        "The video stopped loading. The torrent may be too slow, or the playback engine stopped.",
    };
  }
  return {
    kind: "playback",
    title: "This video can't be played",
    message: conversionFailed
      ? "Converting it stopped unexpectedly. Try again, or pick a lower quality."
      : "Neither the file itself nor the converted version could play.",
  };
}

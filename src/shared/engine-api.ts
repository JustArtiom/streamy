/**
 * The HTTP contract between the engine (src/engine) and the UI (src/renderer).
 * Types only: both sides import this one file.
 *
 * Conventions:
 * - Every `error` / `message` text is for people: a plain sentence, never raw
 *   system text (ENOSPC, stack traces, ffmpeg output). Details go to the logs.
 * - Every route is under /v1. URLs the API returns (e.g. Playback.url) start
 *   with "/v1/…"; the UI puts ENGINE_API_BASE in front.
 * - Times are seconds (floats) on the movie's own timeline. Sizes are bytes.
 *   Dates are ISO 8601 strings.
 * - Errors use ApiError: { error: { code, message, … } }.
 */

/**
 * Where the UI reaches the engine. The main process answers app://streamy/api/*
 * by forwarding the request to the engine (src/main/engine/proxy.ts). The same
 * absolute URL works in production (same origin) and in dev (the page comes
 * from the Vite server, so it's a cross-origin request).
 */
export const ENGINE_API_BASE = "app://streamy/api";

/**
 * The longest magnet link Streamy accepts, from a browser or the add box.
 * Real ones are far shorter; this is a sanity cap shared by main and engine.
 */
export const MAX_MAGNET_LENGTH = 16_384;

// ─── Errors ──────────────────────────────────────────────────────────────────

export const ErrorCode = {
  BadRequest: "BAD_REQUEST",
  ValidationFailed: "VALIDATION_FAILED",
  Unauthorized: "UNAUTHORIZED",
  Forbidden: "FORBIDDEN",
  NotFound: "NOT_FOUND",
  Conflict: "CONFLICT",
  /** The request body is too big (e.g. a .torrent over 10 MB). */
  PayloadTooLarge: "PAYLOAD_TOO_LARGE",
  Internal: "INTERNAL",
  /**
   * Temporarily can't do it: ffmpeg missing, too many transcodes, timed out,
   * the disk is almost full, or (from the proxy) the engine is restarting.
   */
  ServiceUnavailable: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** One field that failed validation, e.g. { path: "body.magnet", … }. */
export type ValidationIssue = {
  path: string;
  message: string;
};

/** The body of every error response (engine and proxy). */
export type ApiError = {
  error: {
    code: ErrorCode;
    message: string;
    issues?: ValidationIssue[];
    requestId?: string;
  };
};

// ─── Health ──────────────────────────────────────────────────────────────────

/**
 * GET /v1/health → Health
 *     Cheap; safe to poll every few seconds.
 */
export type Health = {
  /** Streamy's version (the app's package.json). */
  version: string;
  /** Seconds since the engine started. */
  uptime: number;
  ffmpeg: {
    /** e.g. "8.1.3-Jellyfin". null when ffmpeg couldn't run (see `error`). */
    version: string | null;
    /** A sentence for people, e.g. "ffmpeg is missing or can't run…". */
    error: string | null;
  };
  /**
   * The H.264 encoder transcoding uses: "h264_videotoolbox", "h264_nvenc",
   * "libx264", … null while it's still being detected (a few seconds after start).
   */
  encoder: string | null;
  /** Under 1 GB free on the video folder's disk: downloading is paused. */
  lowDiskSpace: boolean;
};

// ─── Torrents ────────────────────────────────────────────────────────────────

/**
 * POST   /v1/torrents          { magnet } → 201 (new) / 200 (already added) { torrent: TorrentDetail }
 *        `magnet` may also be a bare 40-char hex info hash. A torrent the
 *        library already knows starts from its saved metadata (instant).
 *        The UI also uses this to re-open a torrent that isn't active anymore
 *        (Recent, Continue watching, a reload of the torrent page):
 *        `{ magnet: infoHash }`.
 * POST   /v1/torrents/file     raw .torrent bytes, Content-Type: application/x-bittorrent
 *                              → same as above. Max 10 MB (413).
 * GET    /v1/torrents          → { torrents: TorrentSummary[] } (active torrents,
 *                              most recent activity first)
 * GET    /v1/torrents/:infoHash → { torrent: TorrentDetail }
 *        404 when it isn't active (stopped after being idle, or after a
 *        restart): POST it again to re-open it.
 *        Polling this keeps the torrent active (it counts as "in use").
 * DELETE /v1/torrents/:infoHash[?forget=true] → 204
 *        Stops it and deletes its downloaded data. `forget=true` also removes
 *        it from the library (Recent, Continue watching, saved positions).
 *        Idempotent: 204 even when there was nothing to delete.
 * GET    /v1/torrents/:infoHash/files/:fileIndex/stream
 *        The raw file. Supports Range (206). Used by <video> for direct play.
 *        Reading it makes those pieces urgent.
 */

/**
 * fetching_metadata  a magnet: asking peers for the file list
 * checking           the file list is known; checking the data already on
 *                    disk (after a restart with no resume record). Files are
 *                    listed, playback answers 409 until it's "ready".
 * ready              files can be played
 * error              it failed (see `error`)
 */
export type TorrentStatus =
  "fetching_metadata" | "checking" | "ready" | "error";

export type FileKind = "video" | "audio" | "subtitle" | "image" | "other";

export type TorrentFile = {
  /** Position in the torrent. This is what goes in URLs. */
  index: number;
  /** "Sintel.mp4" */
  name: string;
  /** "Sintel/Sintel.mp4" (path inside the torrent) */
  path: string;
  size: number;
  kind: FileKind;
  /** 0..1 of this file downloaded so far. */
  progress: number;
};

export type TorrentSummary = {
  /** 40 lowercase hex chars. The torrent's id everywhere. */
  infoHash: string;
  /** null until the metadata arrives (magnet links). */
  name: string | null;
  status: TorrentStatus;
  /** Why status is "error", for people. */
  error: string | null;
  /** Total bytes of all files, null until the metadata arrives. */
  size: number | null;
  /** 0..1 of the whole torrent downloaded. */
  progress: number;
  /** Bytes per second. */
  downloadSpeed: number;
  uploadSpeed: number;
  /** Connected peers (including web seeds). */
  peers: number;
  /**
   * ISO 8601. When it became active in this run of the engine (not when it
   * was first added to the library: see LibraryTorrent.addedAt).
   */
  addedAt: string;
  /** ISO 8601. Last time something used it (a page, a stream, a playback). */
  lastActivityAt: string;
};

export type TorrentDetail = TorrentSummary & {
  /** [] until the metadata arrives. */
  files: TorrentFile[];
};

// ─── Media info ──────────────────────────────────────────────────────────────

/**
 * GET /v1/torrents/:infoHash/files/:fileIndex/media → { media: MediaInfo }
 *     Runs ffprobe once (cached). Can take a few seconds: it needs the pieces
 *     holding the file's header (and the end, for some MP4s).
 *
 * GET /v1/torrents/:infoHash/files/:fileIndex/subtitles → { cues: Cue[] }
 *     A subtitle FILE from the torrent (.srt/.vtt/.ass/.ssa) as cues.
 *     The file is downloaded whole (they're tiny), converted once, cached.
 */

export type MediaInfo = {
  /** Seconds. */
  duration: number;
  /** ffprobe's format_name, e.g. "matroska,webm" or "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string;
  /** Bits per second, if known. */
  bitRate: number | null;
  video: VideoInfo | null;
  audioTracks: AudioTrack[];
  /** Embedded tracks AND subtitle files from the same torrent. */
  subtitleTracks: SubtitleTrack[];
};

export type VideoInfo = {
  /** ffprobe codec_name: "h264", "hevc", "av1", "vp9", "mpeg4", … */
  codec: string;
  /** ffprobe profile, e.g. "High", "Main 10". */
  profile: string | null;
  width: number;
  height: number;
  fps: number | null;
  /** 8, 10, 12 */
  bitDepth: number;
  /** HDR10 / HLG. Transcoding tone-maps it to SDR. */
  hdr: boolean;
};

export type AudioTrack = {
  /** Audio-relative index: ffmpeg's `0:a:<index>`. */
  index: number;
  /** "aac", "ac3", "eac3", "dts", "opus", "flac", "mp3", … */
  codec: string;
  channels: number;
  /** ISO 639-1 ("en") when we can tell, else the raw tag ("tlh"), else null. */
  language: string | null;
  /** The track's title tag, e.g. "Director's commentary". */
  title: string | null;
  isDefault: boolean;
};

export type SubtitleTrack = {
  /**
   * "embedded:<n>" = ffmpeg's `0:s:<n>` inside the video file.
   * "file:<fileIndex>" = a subtitle file in the same torrent.
   */
  id: string;
  source: "embedded" | "file";
  /** "subrip", "ass", "mov_text", "webvtt", "hdmv_pgs_subtitle", "dvd_subtitle", … */
  codec: string;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
  /**
   * false = picture-based (PGS, VobSub). Those can't be shown as text: the
   * only way is burning them into the video (Playback.burnSubtitle).
   */
  isText: boolean;
};

export type Cue = {
  /** Seconds on the movie timeline. */
  start: number;
  end: number;
  /** Plain text with "\n" line breaks. May contain <i>, <b>, <u> tags only. */
  text: string;
};

// ─── Playback ────────────────────────────────────────────────────────────────

/**
 * POST   /v1/playback  CreatePlaybackRequest → 201 { playback: Playback }
 *        For remux/transcode this waits until the first segment exists
 *        (up to 2 minutes, then 503).
 * GET    /v1/playback/:id/index.m3u8, /init.mp4, /seg_00000.m4s   (HLS, remux/transcode only)
 * POST   /v1/playback/:id/heartbeat  HeartbeatRequest → { status: PlaybackStatus }
 *        Every ~5 s while the player is open (all modes, direct too). No
 *        heartbeat for 60 s = the session is stopped and deleted.
 *        Each heartbeat also saves the position in the library (Continue
 *        watching), with the session's audio track and `subtitle`.
 * DELETE /v1/playback/:id → 204
 * DELETE /v1/players/:playerId → 204
 *        Stops every session and unfinished start of that player. Sent (with
 *        keepalive) when the player closes.
 * GET    /v1/playback/:id/subtitles/:n?from=<s>&to=<s> → SubtitleCuesResponse
 *        Cues of embedded text track `0:s:<n>` (remux/transcode only: the
 *        same ffmpeg run that makes the video extracts them).
 */

export type Quality = "original" | "1080p" | "720p" | "480p" | "360p";

/**
 * direct    = the player plays the torrent file itself (Range requests).
 * remux     = ffmpeg repackages it into HLS without re-encoding the video.
 * transcode = ffmpeg re-encodes the video (unsupported codec, lower quality,
 *             or burned-in subtitles).
 */
export type PlaybackMode = "direct" | "remux" | "transcode";

/** What the UI can decode, measured by the player (MediaSource / canPlayType). */
export type ClientCapabilities = {
  video: {
    h264: boolean;
    /** 10-bit H.264 ("High 10"). Chromium can't. */
    h264High10: boolean;
    hevc: boolean;
    hevcMain10: boolean;
    av1: boolean;
    vp9: boolean;
  };
  audio: {
    aac: boolean;
    mp3: boolean;
    opus: boolean;
    flac: boolean;
    ac3: boolean;
    eac3: boolean;
  };
  /** Can a plain <video src> play these files progressively (no MediaSource)? */
  direct: {
    mp4: boolean;
    webm: boolean;
  };
};

export type CreatePlaybackRequest = {
  infoHash: string;
  fileIndex: number;
  /** Where to begin, in seconds. */
  start: number;
  /** AudioTrack.index, or null for the file's default track. */
  audioTrack: number | null;
  quality: Quality;
  /** SubtitleTrack.id of a picture subtitle to burn in (forces transcode). */
  burnSubtitle: string | null;
  /**
   * The viewer wants an embedded text subtitle. Embedded cues only come from
   * an ffmpeg run, so a file that could play "direct" plays as "remux".
   */
  embeddedSubtitles: boolean;
  /** Skip the automatic choice, e.g. "remux" after "direct" failed in the player. */
  forceMode: PlaybackMode | null;
  /** The session this one replaces (audio/quality change, far seek): stopped first. */
  replaces: string | null;
  /**
   * A random id the player picks once (one per player on screen). Starting a
   * session stops every other session of the same player, including a start
   * still in progress (whose answer the player no longer wants). Aborting a
   * fetch doesn't reliably reach the engine through Electron's protocol
   * handler, so this is how superseded starts get cleaned up.
   */
  playerId: string;
  capabilities: ClientCapabilities;
};

export type Playback = {
  id: string;
  mode: PlaybackMode;
  /** Why this mode, for people: "This computer can't decode HEVC". */
  reason: string;
  /** direct: the stream URL. remux/transcode: the HLS playlist URL. Starts with "/v1/". */
  url: string;
  /**
   * The movie time (s) at video.currentTime === 0.
   *   movie time = offset + video.currentTime
   * direct: always 0. remux/transcode: where this ffmpeg run really started
   * (the keyframe at or before `start`), so it can be a bit before `start`.
   */
  offset: number;
  /** The whole movie's duration (s), not just this session's part. */
  duration: number;
  /** What the player actually receives. */
  output: {
    videoCodec: string;
    audioCodec: string;
    width: number;
    height: number;
  };
  /** What ffmpeg is using for video, e.g. "h264_videotoolbox", "copy", or null for direct. */
  encoder: string | null;
};

export type PlaybackState =
  | "starting"
  | "running"
  /** ffmpeg is paused because it's far enough ahead of the viewer. */
  | "throttled"
  /** ffmpeg reached the end of the movie. */
  | "finished"
  | "error";

export type PlaybackStatus = {
  state: PlaybackState;
  /**
   * remux/transcode: the movie time (s) produced so far, so the player knows
   * which seeks stay inside this session. direct: null.
   */
  producedUntil: number | null;
  /** For people. ffmpeg's own output stays in the engine log. */
  error: string | null;
};

export type HeartbeatRequest = {
  /** Current movie time (s). */
  position: number;
  paused: boolean;
  /**
   * The subtitle shown right now (SubtitleTrack.id), null = off. Saved with
   * the position so resuming brings it back. Omitted = leave it as saved.
   */
  subtitle?: string | null;
};

export type SubtitleCuesResponse = {
  /** Cues overlapping [from, to]. */
  cues: Cue[];
  /** The movie time range this session has extracted so far. */
  coveredFrom: number;
  coveredTo: number;
};

// ─── Library ─────────────────────────────────────────────────────────────────

/**
 * What Streamy remembers between launches (library.db): torrents you opened
 * and how far you watched each file. Clearing the video cache keeps it.
 *
 * GET    /v1/library → Library
 * GET    /v1/library/:infoHash → { torrent: LibraryTorrent, progress: FileProgress[] }
 *        404 when the library doesn't know it.
 * PUT    /v1/library/:infoHash/files/:fileIndex  ProgressUpdate → { progress: FileProgress }
 *        For when no heartbeat will come: the player closing, "Mark as watched".
 *        404 when the torrent isn't in the library or has no such file.
 * DELETE /v1/library/:infoHash/files/:fileIndex → 204
 *        Removes it from Continue watching (forgets the position).
 * DELETE /v1/library/:infoHash → 204
 *        Forgets the torrent: same as DELETE /v1/torrents/:infoHash?forget=true.
 * GET    /v1/library/:infoHash/files/:fileIndex/thumbnail → image/jpeg
 *        A frame near the saved position, made once in the background.
 *        404 until it exists.
 *
 * Watched rule: past 95%, or within 2 minutes of the end once past 80% (so a
 * short clip isn't "watched" the moment it opens). Watched files leave
 * Continue watching. Positions under 30 s aren't shown there either.
 */

export type LibraryTorrent = {
  infoHash: string;
  name: string;
  /** Bytes of all files. null if the metadata never arrived. */
  size: number | null;
  /** ISO 8601 */
  addedAt: string;
  /** ISO 8601. Recent is sorted by this, newest first. */
  lastOpenedAt: string;
  /** Running in the torrent client right now (connected to peers). */
  active: boolean;
};

export type FileProgress = {
  infoHash: string;
  fileIndex: number;
  /** "Sintel.mp4" (kept so lists render without the torrent's metadata). */
  fileName: string;
  /** Seconds. */
  position: number;
  /** Seconds, null until known. */
  duration: number | null;
  /** AudioTrack.index chosen, null = the file's default. */
  audioTrack: number | null;
  /** SubtitleTrack.id shown, null = off. */
  subtitle: string | null;
  watched: boolean;
  /** ISO 8601 */
  updatedAt: string;
};

export type ContinueWatchingItem = FileProgress & {
  torrentName: string;
  /** "/v1/library/…/thumbnail" once one exists, else null. */
  thumbnailUrl: string | null;
};

export type Library = {
  /** Not watched, position over 30 s, newest first (max 20). */
  continueWatching: ContinueWatchingItem[];
  /** Torrents by lastOpenedAt, newest first (max 50). */
  recent: LibraryTorrent[];
};

export type LibraryTorrentDetail = {
  torrent: LibraryTorrent;
  /** One entry per file with a saved position. */
  progress: FileProgress[];
};

export type ProgressUpdate = {
  /** Seconds. */
  position: number;
  duration: number | null;
  /** Omitted = keep what's saved. */
  audioTrack?: number | null;
  subtitle?: string | null;
  /** Omitted = decided by the watched rule. */
  watched?: boolean;
};

// ─── Cache ───────────────────────────────────────────────────────────────────

/**
 * The video folder (<cacheDir>/torrents, /playback, /subtitles). Used by the
 * main process for Settings → Storage.
 *
 * GET  /v1/cache → CacheInfo
 * POST /v1/cache/clear → 204
 *      Stops every torrent and playback, deletes the downloaded videos.
 *      The library (history, positions) stays.
 */

export type CacheInfo = {
  /** The folder in use (absolute path). */
  dir: string;
  /** false = the folder is gone (e.g. an external drive was unplugged). */
  exists: boolean;
  /** Space the downloaded videos take on disk. */
  usedBytes: number;
  /** The size limit, null = none. */
  limitBytes: number | null;
  /** Free space on that disk, null if unknown. */
  freeBytes: number | null;
  /** Under 1 GB free: downloading is paused. */
  lowDiskSpace: boolean;
};

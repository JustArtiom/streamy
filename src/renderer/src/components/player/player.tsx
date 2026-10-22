import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Captions,
  CaptionsOff,
  FastForward,
  Gauge,
  Pause,
  Play,
  Rewind,
  SkipForward,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, useNavigate } from "react-router";
import type {
  FileProgress,
  MediaInfo,
  Quality,
  TorrentSummary,
} from "../../../../shared/engine-api";
import {
  SUBTITLES_OFF,
  type SettingsUpdate,
} from "../../../../shared/settings";
import { controlButtonClass } from "@/components/player/control-styles";
import { PlaybackEngine } from "@/components/player/playback-engine";
import { PlayerControls } from "@/components/player/player-controls";
import {
  BigPlayButton,
  ErrorOverlay,
  Flash,
  LoadingOverlay,
  ReconnectingOverlay,
} from "@/components/player/player-overlays";
import {
  audioPreferenceUpdate,
  type LocalPrefs,
  type PlaybackSettings,
  playbackSettings,
  readLocalPrefs,
  subtitlePreferenceUpdate,
  writeLocalPrefs,
} from "@/components/player/preferences";
import { type Fit, SettingsMenu } from "@/components/player/settings-menu";
import { speedLabel, stepSpeed } from "@/components/player/speed";
import { StatsPanel } from "@/components/player/stats-panel";
import {
  type SubtitleLook,
  SubtitleOverlay,
} from "@/components/player/subtitle-overlay";
import {
  initialSelection,
  subtitleLabel,
  subtitleToTurnOn,
} from "@/components/player/tracks";
import { useAutoHide } from "@/components/player/use-auto-hide";
import { useKeepScreenAwake } from "@/components/player/use-keep-screen-awake";
import { useMediaSession } from "@/components/player/use-media-session";
import { usePlayerShortcuts } from "@/components/player/use-player-shortcuts";
import { useSubtitleCues } from "@/components/player/use-subtitle-cues";
import { useVideoState } from "@/components/player/use-video-state";
import { useEngineStatus } from "@/hooks/use-engine-status";
import { useGoBack } from "@/hooks/use-go-back";
import { useThumbnailPath } from "@/hooks/use-library";
import { ensureTorrentOpen } from "@/hooks/use-media";
import { browserCapabilities } from "@/lib/capabilities";
import { cn } from "@/lib/cn";
import { setWindowFullScreen, useWindowFullScreen } from "@/lib/full-screen";
import { defaultLocale } from "@/lib/languages";
import { watchPath } from "@/lib/routes";
import { settingsApi, useSettings } from "@/lib/settings";
import { toast } from "@/lib/toast";

/** Another video of the same torrent (Next episode, media keys). */
export type Neighbour = { fileIndex: number; name: string };

export type PlayerProps = {
  infoHash: string;
  fileIndex: number;
  /** null = no media info (ffmpeg isn't working): play the file as it is. */
  media: MediaInfo | null;
  /** The file, readable ("Sintel"). */
  title: string;
  /** The torrent's name, when it says more than the title. */
  subtitle: string | null;
  torrent: TorrentSummary | undefined;
  /** Movie time to begin at: the resume point, or 0. */
  start: number;
  /** Tracks saved with the position, when resuming. */
  savedTracks: Pick<FileProgress, "audioTrack" | "subtitle"> | null;
  previous: Neighbour | null;
  next: Neighbour | null;
};

// Player toasts go top-centre: the bottom is where the controls are.
const PLAYER_TOAST = "top-center";

/** Volume, mute and subtitle delay as state; every change is saved at once. */
function useLocalPrefs() {
  const [prefs, setPrefs] = useState(readLocalPrefs);
  const update = (patch: Partial<LocalPrefs>) => {
    const next = { ...prefs, ...patch };
    writeLocalPrefs(next);
    setPrefs(next);
  };
  return [prefs, update] as const;
}

/** Remembers a choice made in the player in Settings (best effort). */
function updateSettings(patch: SettingsUpdate | null) {
  if (!patch) return;
  settingsApi.update(patch).catch((error: unknown) => {
    console.error("Could not save the player choice:", error);
  });
}

/** The player's Style panel changes the same settings as Settings does. */
function subtitleLookUpdate(patch: Partial<SubtitleLook>): SettingsUpdate {
  const update: SettingsUpdate = {};
  if (patch.size) update.subtitleSize = patch.size;
  if (patch.background) update.subtitleBackground = patch.background;
  if (patch.color) update.subtitleColor = patch.color;
  return update;
}

/** Everything decided once when the player opens. */
function setUp(
  props: PlayerProps,
  settings: PlaybackSettings,
  callbacks: { reopenTorrent: () => Promise<unknown>; onSaved: () => void },
) {
  const { infoHash, fileIndex, media } = props;
  const { audioTrack, subtitleId } = initialSelection(
    media,
    settings,
    props.savedTracks,
  );

  const engine = new PlaybackEngine({
    infoHash,
    fileIndex,
    media,
    raw: media === null,
    capabilities: browserCapabilities(),
    selection: { audioTrack, subtitleId, quality: "original" },
    start: props.start,
    reopenTorrent: callbacks.reopenTorrent,
    onNotice: (message) => {
      toast(message, { position: PLAYER_TOAST });
    },
    onProgressSaved: callbacks.onSaved,
  });

  return { engine, firstSubtitle: subtitleId };
}

export function Player(props: PlayerProps) {
  const { infoHash, fileIndex, media, torrent } = props;
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const settings = playbackSettings(useSettings());
  const [prefs, updatePrefs] = useLocalPrefs();
  const [{ engine, firstSubtitle }] = useState(() =>
    setUp(props, settings, {
      reopenTorrent: () => ensureTorrentOpen(queryClient, infoHash),
      // Lists that show positions (Continue watching, Resume at…) refresh.
      onSaved: () =>
        void queryClient.invalidateQueries({ queryKey: ["library"] }),
    }),
  );
  const [initialPrefs] = useState(prefs);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot);
  const video = useVideoState(videoRef);
  const engineStatus = useEngineStatus();
  const thumbnailPath = useThumbnailPath(infoHash, fileIndex);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState(false);
  const [fit, setFit] = useState<Fit>("contain");
  /** HTML full screen on the player (the button, F, a double-click). */
  const [fullscreen, setFullscreen] = useState(false);
  /** The window's own (View menu, F11, ⌃⌘F); HTML full screen counts too. */
  const windowFullScreen = useWindowFullScreen();
  const [holdControls, setHoldControls] = useState(false);
  const [pipSupported] = useState(
    () =>
      "pictureInPictureEnabled" in document && document.pictureInPictureEnabled,
  );
  /** The subtitle C turns back on. */
  const lastSubtitle = useRef<string | null>(firstSubtitle);

  // ─── Engine lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.volume = initialPrefs.volume;
    element.muted = initialPrefs.muted;
    engine.mount(element);
    return () => {
      engine.unmount();
    };
  }, [engine, initialPrefs]);

  useEffect(() => {
    const onChange = () => {
      setFullscreen(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, []);

  // ─── Derived state ───────────────────────────────────────────────────────

  const { session, phase, selection } = snapshot;
  const offset = session?.offset ?? 0;
  const time = snapshot.pendingSeek ?? offset + video.currentTime;
  const duration = engine.getDuration();
  // While a session is starting there's no video to ask: show the wish.
  const paused = phase === "ready" ? video.paused : !snapshot.playIntent;
  const waiting = phase === "ready" && video.waiting && !video.paused;
  const playing = phase === "ready" && !video.paused && !video.ended;
  const buffered = video.buffered.map(([start, end]) => ({
    start: start + offset,
    end: end + offset,
  }));
  const produced =
    session && session.mode !== "direct" && snapshot.producedUntil !== null
      ? { start: session.offset, end: snapshot.producedUntil }
      : null;
  const subtitleTracks = media?.subtitleTracks ?? [];
  const cues = useSubtitleCues({
    infoHash,
    subtitleId: selection.subtitleId,
    // Only a live session has cues to give (not one that failed or died
    // with a restarted engine).
    session: phase === "loading" || phase === "ready" ? session : null,
    getTime: engine.getMovieTime,
  });
  const subtitleLook: SubtitleLook = {
    size: settings.subtitleSize,
    background: settings.subtitleBackground,
    color: settings.subtitleColor,
  };
  // The app's title bar (with Back) is hidden in full screen: the player
  // shows its own Back then.
  const chromeHidden = fullscreen || windowFullScreen;

  // Tab can reach the controls while they're faded out: they show on focus,
  // and stay while keyboard focus is on them. Not for a mouse click (that
  // focuses a button too), or they'd never go after clicking Play.
  const lastInput = useRef<"keyboard" | "pointer">("pointer");
  const keyboardFocus = useRef(false);
  useEffect(() => {
    const onKeyDown = () => {
      lastInput.current = "keyboard";
    };
    const onPointerDown = () => {
      lastInput.current = "pointer";
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  const keepForFocus = useCallback(
    () =>
      keyboardFocus.current &&
      (containerRef.current?.contains(document.activeElement) ?? false),
    [],
  );

  const { visible, poke, hide } = useAutoHide({
    playing: !paused && phase === "ready",
    hold: holdControls || settingsOpen || phase === "error",
    keep: keepForFocus,
  });

  useKeepScreenAwake(playing);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const [flash, setFlash] = useState<{ id: number; content: ReactNode } | null>(
    null,
  );
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  const showFlash = (content: ReactNode) => {
    setFlash((current) => ({ id: (current?.id ?? 0) + 1, content }));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      setFlash(null);
    }, 700);
  };

  const togglePlay = () => {
    engine.togglePlay();
    poke();
  };

  const seekBy = (seconds: number) => {
    engine.seek(engine.getMovieTime() + seconds);
    showFlash(
      <>
        {seconds < 0 ? <Rewind /> : <FastForward />}
        {seconds < 0 ? "−" : "+"}
        {Math.abs(seconds)} s
      </>,
    );
  };

  const setVolume = (volume: number) => {
    const element = videoRef.current;
    if (!element) return;
    const next = Math.min(1, Math.max(0, Math.round(volume * 100) / 100));
    element.volume = next;
    element.muted = next === 0;
    updatePrefs({ volume: next, muted: next === 0 });
  };

  const toggleMute = () => {
    const element = videoRef.current;
    if (!element) return;
    const muted = !element.muted;
    element.muted = muted;
    // Unmuting at volume 0 would still be silent.
    if (!muted && element.volume === 0) element.volume = 0.5;
    updatePrefs({ muted, volume: element.volume });
    showFlash(
      muted ? (
        <>
          <VolumeX /> Muted
        </>
      ) : (
        <>
          <Volume2 /> {Math.round(element.volume * 100)}%
        </>
      ),
    );
  };

  const setRate = (rate: number) => {
    const element = videoRef.current;
    if (!element) return;
    // defaultPlaybackRate survives the source changes of a session switch.
    element.defaultPlaybackRate = rate;
    element.playbackRate = rate;
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else if (windowFullScreen) {
      // OS full screen (View menu, F11, ⌃⌘F): only the window can leave it.
      setWindowFullScreen(false);
    } else {
      // The container, not the video: controls and subtitles stay visible.
      // HTML full screen also hides the title bar, and Esc leaves it.
      void containerRef.current?.requestFullscreen().catch(() => undefined);
    }
  };

  const togglePip = () => {
    const element = videoRef.current;
    if (!element) return;
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture().catch(() => undefined);
    } else {
      void element.requestPictureInPicture().catch(() => undefined);
    }
  };

  const chooseSubtitle = (id: string | null) => {
    engine.setSubtitle(id);
    if (id !== null) lastSubtitle.current = id;
    // Next time, the same language (or none): the prototype's "sticky"
    // choice, now a setting.
    const track = subtitleTracks.find((item) => item.id === id) ?? null;
    if (id === null || track) updateSettings(subtitlePreferenceUpdate(track));
  };

  const chooseAudio = (index: number) => {
    engine.setAudioTrack(index);
    const track = media?.audioTracks.find((item) => item.index === index);
    updateSettings(audioPreferenceUpdate(track?.language ?? null));
  };

  const chooseQuality = (quality: Quality) => {
    engine.setQuality(quality);
  };

  const toggleSubtitles = () => {
    if (selection.subtitleId) {
      chooseSubtitle(null);
      showFlash(
        <>
          <CaptionsOff /> Subtitles off
        </>,
      );
      return;
    }
    const audioLanguage =
      media?.audioTracks.find((track) => track.index === selection.audioTrack)
        ?.language ?? null;
    const preferred =
      settings.subtitleLanguage === SUBTITLES_OFF
        ? null
        : settings.subtitleLanguage;
    const id =
      lastSubtitle.current ??
      subtitleToTurnOn(subtitleTracks, [
        preferred,
        defaultLocale(),
        audioLanguage,
      ])?.id ??
      null;
    const track = subtitleTracks.find((item) => item.id === id);
    if (!id || !track) {
      showFlash("No subtitles");
      return;
    }
    chooseSubtitle(id);
    showFlash(
      <>
        <Captions /> {subtitleLabel(track)}
      </>,
    );
  };

  const goTo = (neighbour: Neighbour | null) =>
    neighbour
      ? () => {
          void navigate(watchPath(infoHash, neighbour.fileIndex));
        }
      : null;

  usePlayerShortcuts({
    togglePlay: () => {
      togglePlay();
      showFlash(
        paused ? (
          <Play className="fill-current" />
        ) : (
          <Pause className="fill-current" />
        ),
      );
    },
    seekBy: (seconds) => {
      seekBy(seconds);
      poke();
    },
    volumeBy: (delta) => {
      const element = videoRef.current;
      if (!element) return;
      const next = Math.min(1, Math.max(0, element.volume + delta));
      setVolume(next);
      showFlash(
        <>
          {next === 0 ? <VolumeX /> : <Volume2 />} {Math.round(next * 100)}%
        </>,
      );
    },
    toggleMute,
    toggleFullscreen,
    toggleSubtitles,
    seekToFraction: (fraction) => {
      engine.seek(Math.round(duration * fraction * 10) / 10);
      poke();
    },
    speedBy: (direction) => {
      const rate = stepSpeed(video.rate, direction);
      setRate(rate);
      showFlash(
        <>
          <Gauge /> {speedLabel(rate)}
        </>,
      );
    },
    escape: () => {
      if (settingsOpen) setSettingsOpen(false);
      else if (document.fullscreenElement) toggleFullscreen();
    },
  });

  useMediaSession({
    title: props.title,
    artist: props.subtitle ?? torrent?.name ?? null,
    artworkPath: thumbnailPath,
    state:
      phase === "idle" || phase === "error"
        ? null
        : paused
          ? "paused"
          : "playing",
    position: time,
    duration,
    rate: video.rate,
    actions: {
      play: () => {
        engine.play();
      },
      pause: () => {
        engine.pause();
      },
      seekTo: (target) => {
        engine.seek(target);
      },
      seekBy: (seconds) => {
        engine.seek(engine.getMovieTime() + seconds);
      },
    },
    previous: goTo(props.previous),
    next: goTo(props.next),
  });

  // ─── Render ──────────────────────────────────────────────────────────────

  const lastPointer = useRef("mouse");
  const closingMenu = useRef(false);
  const showBigPlay = phase === "ready" && paused && !waiting && !settingsOpen;

  return (
    <div
      ref={containerRef}
      data-testid="player"
      className={cn(
        // Dark whatever the theme: tokens inside resolve to their dark values.
        "absolute inset-0 overflow-hidden bg-black text-foreground [color-scheme:dark] select-none",
        !visible && "cursor-none",
      )}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse") poke();
      }}
      onFocusCapture={() => {
        keyboardFocus.current = lastInput.current === "keyboard";
        poke();
      }}
      // The mouse left the window: like a desktop player, the controls go.
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse" && !paused) hide();
      }}
    >
      <video
        ref={videoRef}
        playsInline
        className={cn(
          "absolute inset-0 size-full",
          fit === "fill" ? "object-cover" : "object-contain",
        )}
      />

      {/* Clicks on the picture: play/pause with a mouse (a double-click is
          full screen, and its two clicks cancel out), show/hide the
          controls on a touch screen. */}
      <div
        className="absolute inset-0 touch-manipulation"
        onPointerDown={() => {
          // The menu closes on this same press (before "click" fires), so
          // remember now that this press is only for closing it.
          closingMenu.current = settingsOpen;
        }}
        onPointerUp={(event) => {
          lastPointer.current = event.pointerType;
        }}
        onClick={() => {
          if (closingMenu.current) return;
          if (lastPointer.current === "touch") {
            if (visible) hide();
            else poke();
            return;
          }
          togglePlay();
        }}
        onDoubleClick={() => {
          if (lastPointer.current !== "touch") toggleFullscreen();
        }}
      />

      <SubtitleOverlay
        cues={cues.cues}
        getTime={engine.getMovieTime}
        delay={prefs.subtitleDelay}
        look={subtitleLook}
        raised={visible}
      />

      {phase !== "error" && phase !== "reconnecting" && (
        <LoadingOverlay
          phase={phase}
          waiting={waiting}
          mode={session?.mode ?? null}
          torrent={torrent}
        />
      )}
      {phase === "reconnecting" && (
        <ReconnectingOverlay status={engineStatus} />
      )}
      {showBigPlay && <BigPlayButton onPlay={togglePlay} />}
      <Flash flash={flash} />

      {stats && (
        <StatsPanel
          snapshot={snapshot}
          media={media}
          torrent={torrent}
          videoRef={videoRef}
          getTime={engine.getMovieTime}
          onClose={() => {
            setStats(false);
          }}
        />
      )}

      <TopBar
        title={props.title}
        subtitle={props.subtitle}
        next={props.next}
        infoHash={infoHash}
        showBack={chromeHidden}
        visible={visible}
      />

      <PlayerControls
        visible={visible}
        paused={paused}
        time={time}
        duration={duration}
        buffered={buffered}
        produced={produced}
        volume={video.volume}
        muted={video.muted}
        subtitlesOn={selection.subtitleId !== null}
        hasSubtitles={subtitleTracks.length > 0}
        settingsOpen={settingsOpen}
        settingsButtonRef={settingsButtonRef}
        pipSupported={pipSupported}
        fullscreen={chromeHidden}
        onTogglePlay={togglePlay}
        onSeek={(target) => {
          engine.seek(target);
        }}
        onSeekBy={seekBy}
        onVolume={setVolume}
        onToggleMute={toggleMute}
        onToggleSubtitles={toggleSubtitles}
        onToggleSettings={() => {
          setSettingsOpen((open) => !open);
        }}
        onPip={togglePip}
        onToggleFullscreen={toggleFullscreen}
        onHoldChange={setHoldControls}
        settingsMenu={
          settingsOpen && (
            <SettingsMenu
              anchorRef={settingsButtonRef}
              onClose={() => {
                setSettingsOpen(false);
              }}
              media={media}
              selection={selection}
              onQuality={chooseQuality}
              onAudio={chooseAudio}
              onSubtitle={chooseSubtitle}
              subtitleLook={subtitleLook}
              onSubtitleLook={(patch) => {
                updateSettings(subtitleLookUpdate(patch));
              }}
              subtitleDelay={prefs.subtitleDelay}
              onSubtitleDelay={(subtitleDelay) => {
                updatePrefs({ subtitleDelay });
              }}
              rate={video.rate}
              onRate={setRate}
              fit={fit}
              onFit={setFit}
              stats={stats}
              onStats={setStats}
            />
          )
        }
      />

      {phase === "error" && snapshot.error && (
        <ErrorOverlay
          error={snapshot.error}
          onRetry={() => {
            engine.retry();
          }}
        />
      )}
    </div>
  );
}

/** The title over the video, with Next episode (and Back in full screen). */
function TopBar({
  title,
  subtitle,
  next,
  infoHash,
  showBack,
  visible,
}: {
  title: string;
  subtitle: string | null;
  next: Neighbour | null;
  infoHash: string;
  showBack: boolean;
  visible: boolean;
}) {
  const goBack = useGoBack();
  return (
    <div
      className={cn(
        // Above the error message too, so Back always works.
        "absolute inset-x-0 top-0 z-40 flex items-center gap-2 bg-linear-to-b from-black/75 to-transparent px-4 pt-3 pb-12 transition-opacity duration-300",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {showBack && (
        <button
          type="button"
          aria-label="Back"
          title="Back"
          className={controlButtonClass}
          onClick={goBack}
        >
          <ArrowLeft />
        </button>
      )}
      {/* dir="auto": a Hebrew or Arabic name reads right to left. */}
      <div className="min-w-0 flex-1 px-1">
        <h1 dir="auto" className="truncate text-base font-medium text-white">
          {title}
        </h1>
        {subtitle && (
          <p dir="auto" className="truncate text-xs text-white/60">
            {subtitle}
          </p>
        )}
      </div>
      {next && (
        <Link
          to={watchPath(infoHash, next.fileIndex)}
          title={next.name}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 text-sm font-medium text-white backdrop-blur-sm transition-colors outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/40 [&_svg]:size-4"
        >
          Next episode
          <SkipForward />
        </Link>
      )}
    </div>
  );
}

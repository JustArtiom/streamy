import {
  Captions,
  CaptionsOff,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import type { TimeRange } from "@/components/player/playback-logic";
import { controlButtonClass } from "@/components/player/control-styles";
import { Scrubber } from "@/components/player/scrubber";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

export function ControlButton({
  label,
  shortcut,
  className,
  ...props
}: ComponentProps<"button"> & { label: string; shortcut?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cn(controlButtonClass, className)}
      {...props}
    />
  );
}

export type PlayerControlsProps = {
  visible: boolean;
  paused: boolean;
  time: number;
  duration: number;
  buffered: TimeRange[];
  produced: TimeRange | null;
  volume: number;
  muted: boolean;
  subtitlesOn: boolean;
  hasSubtitles: boolean;
  settingsOpen: boolean;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  pipSupported: boolean;
  fullscreen: boolean;
  onTogglePlay: () => void;
  onSeek: (time: number) => void;
  onSeekBy: (seconds: number) => void;
  onVolume: (volume: number) => void;
  onToggleMute: () => void;
  onToggleSubtitles: () => void;
  onToggleSettings: () => void;
  onPip: () => void;
  onToggleFullscreen: () => void;
  onHoldChange: (hold: boolean) => void;
  /** The settings popover, anchored above the settings button. */
  settingsMenu: ReactNode;
};

export function PlayerControls({
  visible,
  paused,
  time,
  duration,
  buffered,
  produced,
  volume,
  muted,
  subtitlesOn,
  hasSubtitles,
  settingsOpen,
  settingsButtonRef,
  pipSupported,
  fullscreen,
  onTogglePlay,
  onSeek,
  onSeekBy,
  onVolume,
  onToggleMute,
  onToggleSubtitles,
  onToggleSettings,
  onPip,
  onToggleFullscreen,
  onHoldChange,
  settingsMenu,
}: PlayerControlsProps) {
  const VolumeIcon =
    muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-black/85 via-black/45 to-transparent px-4 pt-16 pb-2 transition-opacity duration-300",
        visible ? "opacity-100" : "pointer-events-none opacity-0",
      )}
      // Resting on the controls keeps them up.
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onHoldChange(true);
      }}
      onPointerLeave={() => {
        onHoldChange(false);
      }}
    >
      <div className="px-1.5">
        <Scrubber
          duration={duration}
          time={time}
          buffered={buffered}
          produced={produced}
          onSeek={onSeek}
        />
      </div>

      <div className="flex items-center gap-1">
        <ControlButton
          label={paused ? "Play" : "Pause"}
          shortcut="Space"
          onClick={onTogglePlay}
        >
          {paused ? (
            <Play className="fill-current" />
          ) : (
            <Pause className="fill-current" />
          )}
        </ControlButton>
        <ControlButton
          label="Back 10 seconds"
          shortcut="J"
          onClick={() => {
            onSeekBy(-10);
          }}
        >
          <RotateCcw />
        </ControlButton>
        <ControlButton
          label="Forward 10 seconds"
          shortcut="L"
          onClick={() => {
            onSeekBy(10);
          }}
        >
          <RotateCw />
        </ControlButton>

        <div className="group/volume flex items-center">
          <ControlButton
            label={muted ? "Unmute" : "Mute"}
            shortcut="M"
            onClick={onToggleMute}
          >
            <VolumeIcon />
          </ControlButton>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(event) => {
              onVolume(Number(event.target.value));
            }}
            className="h-1 w-0 cursor-pointer accent-white opacity-0 transition-all duration-200 group-focus-within/volume:w-20 group-focus-within/volume:opacity-100 group-hover/volume:w-20 group-hover/volume:opacity-100"
          />
        </div>

        <span className="ml-1.5 font-mono text-sm whitespace-nowrap text-foreground/90 tabular-nums">
          {formatTime(time)}
          <span className="text-foreground/50"> / {formatTime(duration)}</span>
        </span>

        <div className="flex-1" />

        {hasSubtitles && (
          <ControlButton
            label={subtitlesOn ? "Turn subtitles off" : "Turn subtitles on"}
            shortcut="C"
            aria-pressed={subtitlesOn}
            onClick={onToggleSubtitles}
          >
            {subtitlesOn ? <Captions /> : <CaptionsOff />}
          </ControlButton>
        )}

        <div className="relative">
          <ControlButton
            ref={settingsButtonRef}
            label="Settings"
            aria-haspopup="menu"
            aria-expanded={settingsOpen}
            onClick={onToggleSettings}
          >
            <Settings
              className={cn(
                "transition-transform duration-300",
                settingsOpen && "rotate-45",
              )}
            />
          </ControlButton>
          {settingsMenu}
        </div>

        {pipSupported && (
          <ControlButton label="Picture in picture" onClick={onPip}>
            <PictureInPicture2 />
          </ControlButton>
        )}
        <ControlButton
          label={fullscreen ? "Exit full screen" : "Full screen"}
          shortcut="F"
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize /> : <Maximize />}
        </ControlButton>
      </div>
    </div>
  );
}

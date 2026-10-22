import { type KeyboardEvent, type PointerEvent, useRef, useState } from "react";
import type { TimeRange } from "@/components/player/playback-logic";
import { cn } from "@/lib/cn";
import { formatTime } from "@/lib/format";

const KEY_STEPS: Record<string, number> = {
  ArrowLeft: -5,
  ArrowDown: -5,
  ArrowRight: 5,
  ArrowUp: 5,
  PageDown: -60,
  PageUp: 60,
};

function percent(value: number, duration: number) {
  if (duration <= 0) return 0;
  return Math.min(100, Math.max(0, (value / duration) * 100));
}

/**
 * The timeline. Everything is movie time: played, what the browser has
 * buffered, and (HLS) what the server's ffmpeg has produced so far, which is
 * where a seek stays inside the current session.
 *
 * Dragging only previews; the seek happens on release, so dragging across a
 * remux movie doesn't start an ffmpeg per pixel.
 */
export function Scrubber({
  duration,
  time,
  buffered,
  produced,
  onSeek,
}: {
  duration: number;
  time: number;
  buffered: TimeRange[];
  produced: TimeRange | null;
  onSeek: (time: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    const fraction = Math.min(
      1,
      Math.max(0, (clientX - rect.left) / rect.width),
    );
    return fraction * duration;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || duration <= 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag(timeAt(event.clientX));
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = timeAt(event.clientX);
    if (event.pointerType === "mouse") setHover(at);
    if (drag !== null) setDrag(at);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const at = timeAt(event.clientX);
    setDrag(null);
    onSeek(at);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let target: number | null = null;
    const step = KEY_STEPS[event.key];
    if (step !== undefined) target = time + step;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = duration;
    if (target === null) return;
    // Handled here; the player's own shortcuts must not seek a second time.
    event.preventDefault();
    event.stopPropagation();
    onSeek(Math.min(duration, Math.max(0, target)));
  };

  const shown = drag ?? time;
  const tooltipAt = drag ?? hover;

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shown)}
      aria-valuetext={`${formatTime(shown)} of ${formatTime(duration)}`}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDrag(null);
      }}
      onPointerLeave={() => {
        setHover(null);
      }}
      className="group/scrubber relative flex h-6 cursor-pointer touch-none items-center rounded outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <div
        ref={trackRef}
        className={cn(
          "relative h-1 w-full overflow-hidden rounded-full bg-white/20 transition-[height] duration-150 group-hover/scrubber:h-1.5",
          drag !== null && "h-1.5",
        )}
      >
        {produced && (
          <div
            data-testid="produced"
            className="absolute inset-y-0 bg-white/15"
            style={{
              left: `${percent(produced.start, duration)}%`,
              width: `${percent(produced.end - produced.start, duration)}%`,
            }}
          />
        )}
        {buffered.map((range) => (
          <div
            key={range.start}
            className="absolute inset-y-0 bg-white/35"
            style={{
              left: `${percent(range.start, duration)}%`,
              width: `${percent(range.end - range.start, duration)}%`,
            }}
          />
        ))}
        <div
          className="absolute inset-y-0 left-0 bg-white"
          style={{ width: `${percent(shown, duration)}%` }}
        />
      </div>

      <div
        className={cn(
          "pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-md shadow-black/40 transition-transform duration-150",
          drag !== null
            ? "scale-110"
            : "scale-0 group-hover/scrubber:scale-100 group-focus-visible/scrubber:scale-100",
        )}
        style={{ left: `${percent(shown, duration)}%` }}
      />

      {tooltipAt !== null && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-md bg-black/85 px-2 py-1 font-mono text-xs text-white tabular-nums"
          // Kept inside the bar so the label never runs off the screen.
          style={{
            left: `clamp(1.75rem, ${percent(tooltipAt, duration)}%, calc(100% - 1.75rem))`,
          }}
        >
          {formatTime(tooltipAt)}
        </div>
      )}
    </div>
  );
}

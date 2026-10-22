import { Play, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { engineUrl } from "@/lib/api";
import { formatTime } from "@/lib/format";

/**
 * Asked before playback starts when there's a saved position: carry on, or
 * watch from the beginning. "Resume" has the focus, so Enter resumes.
 */
export function ResumePrompt({
  title,
  position,
  duration,
  thumbnailPath,
  onResume,
  onStartOver,
}: {
  title: string;
  /** Seconds. */
  position: number;
  /** Seconds, null when unknown. */
  duration: number | null;
  /** The engine's picture of the video ("/v1/…"), when there's one. */
  thumbnailPath: string | null;
  onResume: () => void;
  onStartOver: () => void;
}) {
  const headingId = useId();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const percent =
    duration && duration > 0
      ? Math.min(100, Math.max(0, (position / duration) * 100))
      : null;

  return (
    <div className="absolute inset-0 flex items-center justify-center p-6">
      {/* A frame from the video, dimmed, when the engine has one. */}
      {thumbnailPath && !thumbnailFailed && (
        <img
          src={engineUrl(thumbnailPath)}
          alt=""
          draggable={false}
          onError={() => {
            setThumbnailFailed(true);
          }}
          className="absolute inset-0 size-full scale-105 object-cover opacity-35 blur-md"
        />
      )}
      <section
        aria-labelledby={headingId}
        className="relative flex w-full max-w-sm flex-col items-center gap-5 text-center"
      >
        <div className="flex w-full flex-col gap-1.5">
          <p className="text-xs font-medium tracking-wide text-white/60 uppercase">
            Continue watching
          </p>
          <h2
            id={headingId}
            dir="auto"
            className="text-lg font-semibold text-balance [overflow-wrap:anywhere] text-white"
          >
            {title}
          </h2>
        </div>

        {percent !== null && duration !== null && (
          <div className="flex w-full flex-col gap-1.5">
            <div
              role="progressbar"
              aria-label="Watched so far"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.floor(percent)}
              className="h-1 w-full overflow-hidden rounded-full bg-white/20"
            >
              <div
                className="h-full rounded-full bg-white"
                style={{ width: `${percent}%` }}
              />
            </div>
            <p className="font-mono text-xs text-white/60 tabular-nums">
              {formatTime(position)} of {formatTime(duration)}
            </p>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            // Enter (or Space) resumes right away.
            autoFocus
            onClick={onResume}
          >
            <Play className="fill-current" aria-hidden />
            Resume at {formatTime(position)}
          </Button>
          <Button variant="outline" onClick={onStartOver}>
            <RotateCcw aria-hidden />
            Start over
          </Button>
        </div>
      </section>
    </div>
  );
}

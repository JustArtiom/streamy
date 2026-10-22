import { type ReactNode, useEffect, useState } from "react";
import type { Cue } from "../../../../shared/engine-api";
import type {
  SubtitleBackground,
  SubtitleColor,
  SubtitleSize,
} from "../../../../shared/settings";
import {
  activeCues,
  type CueNode,
  cueKey,
  parseCueText,
} from "@/components/player/cues";
import { cn } from "@/lib/cn";
import {
  SUBTITLE_BACKGROUND_CLASS,
  SUBTITLE_COLOR_CLASS,
  SUBTITLE_SIZE_SCALE,
} from "@/lib/subtitle-style";

/** How subtitles look (Settings → Playback, or the player's Style panel). */
export type SubtitleLook = {
  size: SubtitleSize;
  background: SubtitleBackground;
  color: SubtitleColor;
};

/**
 * The base ("M") size grows with the player, within readable limits.
 * Settings' preview uses the same scale factors on a fixed base.
 */
const BASE_SIZE = "clamp(15px, 2.6vw, 34px)";

/** Cue nodes → React elements. Text stays text: nothing is parsed as HTML. */
function renderCueNodes(nodes: CueNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    if (node.type === "br") return <br key={i} />;
    if (node.type === "text") return node.text;
    const children = renderCueNodes(node.children);
    if (node.tag === "i") return <i key={i}>{children}</i>;
    if (node.tag === "b") return <b key={i}>{children}</b>;
    return <u key={i}>{children}</u>;
  });
}

/** The cues on screen right now; follows the video frame by frame. */
function useActiveCues(
  cues: readonly Cue[],
  getTime: () => number,
  delay: number,
) {
  const [active, setActive] = useState<Cue[]>([]);

  useEffect(() => {
    let frame = 0;
    // null, not "": the first tick must always set the lines. With "", turning
    // subtitles off (no cues → key "") never cleared the line on screen.
    let lastKey: string | null = null;
    const tick = () => {
      const now = activeCues(cues, getTime(), delay);
      const key = now.map(cueKey).join("\n");
      // Only re-render when the lines change, not 60 times a second.
      if (key !== lastKey) {
        lastKey = key;
        setActive(now);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [cues, getTime, delay]);

  return active;
}

export function SubtitleOverlay({
  cues,
  getTime,
  delay,
  look,
  raised,
}: {
  cues: readonly Cue[];
  /** Movie time now. */
  getTime: () => number;
  /** Seconds; positive = later. */
  delay: number;
  look: SubtitleLook;
  /** The controls are showing: move up so they don't cover the text. */
  raised: boolean;
}) {
  const active = useActiveCues(cues, getTime, delay);
  if (active.length === 0) return null;

  return (
    <div
      data-testid="subtitles"
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 flex flex-col items-center gap-1 px-4 text-center transition-[bottom] duration-200",
        raised ? "bottom-28" : "bottom-10",
      )}
    >
      {active.map((cue) => (
        <p
          key={cueKey(cue)}
          className={cn(
            "max-w-[min(90%,60rem)] box-decoration-clone leading-[1.3] font-medium [overflow-wrap:anywhere]",
            SUBTITLE_COLOR_CLASS[look.color],
          )}
          style={{
            fontSize: `calc(${BASE_SIZE} * ${SUBTITLE_SIZE_SCALE[look.size]})`,
          }}
        >
          <span
            className={cn(
              "box-decoration-clone",
              SUBTITLE_BACKGROUND_CLASS[look.background],
            )}
          >
            {renderCueNodes(parseCueText(cue.text))}
          </span>
        </p>
      ))}
    </div>
  );
}

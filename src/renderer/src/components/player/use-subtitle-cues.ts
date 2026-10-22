import { useEffect, useState } from "react";
import type { Cue, Playback } from "../../../../shared/engine-api";
import { mergeCues } from "@/components/player/cues";
import {
  embeddedStreamIndex,
  subtitleFileIndex,
} from "@/components/player/tracks";
import { useFileSubtitles } from "@/hooks/use-media";
import { api } from "@/lib/api";

const POLL_MS = 5000;
const EMPTY: readonly Cue[] = [];

/**
 * The cues of the chosen subtitle track, on the movie timeline.
 * - A file in the torrent: all cues at once.
 * - An embedded text track: ffmpeg extracts it as it goes, so we ask for the
 *   window around the playhead every 5 s (and when the session changes) and
 *   keep everything we've seen.
 */
export function useSubtitleCues(input: {
  infoHash: string;
  subtitleId: string | null;
  session: Playback | null;
  getTime: () => number;
}) {
  const { infoHash, subtitleId, session, getTime } = input;
  const fileIndex = subtitleFileIndex(subtitleId);
  const stream = embeddedStreamIndex(subtitleId);
  const fileCues = useFileSubtitles(infoHash, fileIndex);

  // Cues are tagged with the track they belong to, so switching tracks never
  // shows the previous one's lines (and no reset-in-effect is needed).
  const [embedded, setEmbedded] = useState<{
    id: string | null;
    cues: readonly Cue[];
  }>({
    id: null,
    cues: EMPTY,
  });

  const sessionId = session && session.mode !== "direct" ? session.id : null;

  useEffect(() => {
    if (stream === null || sessionId === null || subtitleId === null) return;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();
      const time = getTime();
      try {
        const response = await api.getPlaybackSubtitles(
          sessionId,
          stream,
          Math.max(0, time - 5),
          time + 60,
          controller.signal,
        );
        setEmbedded((current) =>
          current.id === subtitleId
            ? { id: subtitleId, cues: mergeCues(current.cues, response.cues) }
            : { id: subtitleId, cues: mergeCues(EMPTY, response.cues) },
        );
      } catch {
        // 404 = this session has no cues for that track (ffmpeg couldn't
        // extract it). Nothing to show; the next session may do better.
        // Aborted = a newer poll replaced this one.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      clearInterval(timer);
      controller?.abort();
    };
  }, [stream, sessionId, subtitleId, getTime]);

  if (fileIndex !== null) {
    return {
      cues: fileCues.data ?? EMPTY,
      loading: fileCues.isPending,
      error: fileCues.error,
    };
  }
  if (stream !== null) {
    return {
      cues: embedded.id === subtitleId ? embedded.cues : EMPTY,
      loading: false,
      error: null,
    };
  }
  return { cues: EMPTY, loading: false, error: null };
}

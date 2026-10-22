import { type RefObject, useEffect, useState } from "react";

export type VideoState = {
  paused: boolean;
  /** The browser is waiting for data (spinner). */
  waiting: boolean;
  ended: boolean;
  /** Session time (add the session offset for movie time). */
  currentTime: number;
  /** Session time ranges [start, end]. */
  buffered: [number, number][];
  volume: number;
  muted: boolean;
  rate: number;
  videoWidth: number;
  videoHeight: number;
};

const INITIAL: VideoState = {
  paused: true,
  waiting: false,
  ended: false,
  currentTime: 0,
  buffered: [],
  volume: 1,
  muted: false,
  rate: 1,
  videoWidth: 0,
  videoHeight: 0,
};

const EVENTS = [
  "play",
  "pause",
  "playing",
  "waiting",
  "seeking",
  "seeked",
  "canplay",
  "timeupdate",
  "progress",
  "volumechange",
  "ratechange",
  "ended",
  "emptied",
  "loadedmetadata",
  "resize",
] as const;

function read(video: HTMLVideoElement, waiting: boolean): VideoState {
  const buffered: [number, number][] = [];
  for (let i = 0; i < video.buffered.length; i++) {
    buffered.push([video.buffered.start(i), video.buffered.end(i)]);
  }
  return {
    paused: video.paused,
    waiting,
    ended: video.ended,
    currentTime: video.currentTime,
    buffered,
    volume: video.volume,
    muted: video.muted,
    rate: video.playbackRate,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight,
  };
}

function same(a: VideoState, b: VideoState) {
  return (
    a.paused === b.paused &&
    a.waiting === b.waiting &&
    a.ended === b.ended &&
    a.currentTime === b.currentTime &&
    a.volume === b.volume &&
    a.muted === b.muted &&
    a.rate === b.rate &&
    a.videoWidth === b.videoWidth &&
    a.videoHeight === b.videoHeight &&
    a.buffered.length === b.buffered.length &&
    a.buffered.every(([start, end], i) => {
      const other = b.buffered[i];
      return other !== undefined && start === other[0] && end === other[1];
    })
  );
}

/** What the <video> element is doing, as React state (re-renders ~4×/s while playing). */
export function useVideoState(ref: RefObject<HTMLVideoElement | null>) {
  const [state, setState] = useState(INITIAL);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let waiting = false;

    const onEvent = (event: Event) => {
      // "waiting" turns the spinner on; anything that means frames are
      // flowing again turns it off.
      if (event.type === "waiting" || event.type === "seeking") waiting = true;
      if (
        event.type === "playing" ||
        event.type === "canplay" ||
        event.type === "seeked" ||
        event.type === "emptied" ||
        event.type === "pause"
      ) {
        waiting = event.type === "seeked" ? video.readyState < 3 : false;
      }
      const next = read(video, waiting);
      setState((current) => (same(current, next) ? current : next));
    };

    for (const type of EVENTS) video.addEventListener(type, onEvent);
    return () => {
      for (const type of EVENTS) video.removeEventListener(type, onEvent);
    };
  }, [ref]);

  return state;
}

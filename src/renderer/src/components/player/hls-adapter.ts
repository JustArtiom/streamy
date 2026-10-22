import Hls, { ErrorTypes, Events } from "hls.js";
import { hlsConfig } from "@/components/player/hls-config";
import type { FailureKind } from "@/components/player/playback-logic";

/**
 * The few things the engine needs from hls.js. A small seam so the engine can
 * be tested with a fake, and the hls.js event details stay in one place.
 */
export type HlsAdapter = {
  load: (url: string, video: HTMLVideoElement) => void;
  /** Total duration of the playlist so far (session time), on every reload. */
  onPlaylist: (listener: (totalDuration: number) => void) => void;
  /** Only fatal errors: hls.js already retried the rest by itself. */
  onFatalError: (
    listener: (kind: FailureKind, details: string, httpStatus?: number) => void,
  ) => void;
  stopLoad: () => void;
  recoverMediaError: () => void;
  destroy: () => void;
};

export type HlsSupport = {
  isSupported: () => boolean;
  create: (startPosition: number) => HlsAdapter;
};

export const realHls: HlsSupport = {
  isSupported: () => Hls.isSupported(),
  create: (startPosition) => {
    const hls = new Hls(hlsConfig(startPosition));
    return {
      load: (url, video) => {
        hls.loadSource(url);
        hls.attachMedia(video);
      },
      onPlaylist: (listener) => {
        hls.on(Events.LEVEL_UPDATED, (_event, data) => {
          listener(data.details.totalduration);
        });
      },
      onFatalError: (listener) => {
        hls.on(Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          const kind: FailureKind =
            data.type === ErrorTypes.NETWORK_ERROR ? "network" : "media";
          listener(kind, data.details, data.response?.code);
        });
      },
      stopLoad: () => {
        hls.stopLoad();
      },
      recoverMediaError: () => {
        hls.recoverMediaError();
      },
      destroy: () => {
        hls.destroy();
      },
    };
  },
};

import type {
  SubtitleBackground,
  SubtitleColor,
  SubtitleSize,
} from "../../../shared/settings";

// How subtitles look, from Settings → Playback. Shared by the player's
// subtitle overlay and the settings preview, so both look the same.

/**
 * Size relative to the player's base subtitle size. The player scales the
 * base with its own size (e.g. clamp(15px, 2.6vw, 34px) for "m").
 */
export const SUBTITLE_SIZE_SCALE: Record<SubtitleSize, number> = {
  s: 0.8,
  m: 1,
  l: 1.25,
  xl: 1.55,
};

/** Classes for the text's own <span> (box-decoration-clone for multi-line). */
export const SUBTITLE_BACKGROUND_CLASS: Record<SubtitleBackground, string> = {
  none: "",
  // A dark outline all around reads on any picture, like most TV subtitles.
  shadow: "[text-shadow:0_0_2px_#000,0_0_2px_#000,0_0_4px_#000,0_1px_3px_#000]",
  box: "rounded-[0.15em] bg-black/75 px-[0.35em] py-[0.05em]",
};

export const SUBTITLE_COLOR_CLASS: Record<SubtitleColor, string> = {
  white: "text-white",
  yellow: "text-yellow-300",
};

export const platform = window.streamy.platform;
export const isMac = platform === "darwin";

/** True when the shortcut modifier (⌘ on macOS, Ctrl elsewhere) is held. */
export function isModKey(event: KeyboardEvent): boolean {
  return isMac ? event.metaKey : event.ctrlKey;
}

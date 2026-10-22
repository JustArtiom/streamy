import { useSyncExternalStore } from "react";
import { readJson, writeJson } from "@/lib/storage";

// The one-time privacy notice (PLAN.md §13, decision 3): after the first
// torrent is added, say once that peers can see your IP address. It stays
// until it's dismissed, also after a restart, then never shows again.

const KEY = "streamy-ip-notice";

type State = "unseen" | "showing" | "dismissed";

function read(): State {
  const value = readJson(KEY);
  return value === "showing" || value === "dismissed" ? value : "unseen";
}

let state: State = read();
const listeners = new Set<() => void>();

function set(next: State) {
  if (state === next) return;
  state = next;
  writeJson(KEY, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Call after a torrent was added: shows the notice unless it was dismissed. */
export function noteTorrentAdded(): void {
  if (state === "unseen") set("showing");
}

export function dismissIpNotice(): void {
  set("dismissed");
}

export function useIpNoticeVisible(): boolean {
  return useSyncExternalStore(subscribe, () => state === "showing");
}

/** Tests: start over as if Streamy was just installed. */
export function resetIpNoticeForTests(): void {
  state = read();
  for (const listener of listeners) listener();
}

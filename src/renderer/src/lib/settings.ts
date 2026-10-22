import { useSyncExternalStore } from "react";
import type { SettingsSnapshot } from "../../../shared/settings";
import { peopleText, SOMETHING_WENT_WRONG } from "@/lib/people-text";

// The UI's view of the settings. The main process owns them; this keeps a
// copy that updates whenever they change (from this window or anywhere else).

type Listener = () => void;

function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const settingsStore = createStore<SettingsSnapshot | null>(null);
const dialogStore = createStore(false);
/** The section the dialog shows (null = the first one). Kept while closed. */
const sectionStore = createStore<string | null>(null);

// Start listening right away (before React renders), so nothing is missed.
window.streamy.settings.onChange(settingsStore.set);
window.streamy.onOpenSettings(() => {
  dialogStore.set(true);
});
window.streamy.settings
  .get()
  .then(settingsStore.set)
  .catch((error: unknown) => {
    console.error("Could not load the settings:", error);
  });

/** The current settings, or null for the moment before they've loaded. */
export function useSettings(): SettingsSnapshot | null {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get);
}

/** Reading and changing settings (the main process validates everything). */
export const settingsApi = window.streamy.settings;

/** Settings that live in the OS: open at login, magnet links. */
export const systemApi = window.streamy.system;

/**
 * Runs a settings action and turns any failure into a message for the user
 * (or null when it worked). Actions that can fail in an expected way return
 * `{ status: "error", message }` (ActionResult, ChooseCacheDirResult). That
 * message comes from the main process, so it goes through peopleText too.
 */
export async function runAction(
  action: () => Promise<unknown>,
): Promise<string | null> {
  try {
    const result = await action();
    if (isErrorResult(result)) return peopleText(result.message);
    return null;
  } catch (error) {
    console.error(error);
    return SOMETHING_WENT_WRONG;
  }
}

function isErrorResult(value: unknown): value is { message: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "error" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

export function useSettingsDialogOpen(): boolean {
  return useSyncExternalStore(dialogStore.subscribe, dialogStore.get);
}

/**
 * Opens the dialog on a given section (e.g. "storage"), or on the one it
 * showed last.
 */
export function openSettings(section?: string): void {
  if (section) sectionStore.set(section);
  dialogStore.set(true);
}

export function closeSettings(): void {
  dialogStore.set(false);
}

/** The id of the section the dialog shows, or null for the first one. */
export function useSettingsSection(): string | null {
  return useSyncExternalStore(sectionStore.subscribe, sectionStore.get);
}

export function showSettingsSection(section: string): void {
  sectionStore.set(section);
}

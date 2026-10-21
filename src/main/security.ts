import { app, session, shell } from "electron";
import { isAppUrl } from "./protocol";

// Electron security checklist:
// https://www.electronjs.org/docs/latest/tutorial/security

/** Permissions the UI may use. Everything else (camera, mic, location…) is denied. */
const ALLOWED_PERMISSIONS = new Set([
  "fullscreen",
  "clipboard-sanitized-write",
]);

/** Opens http(s) links in the user's browser. Nothing else (no file:, no custom schemes). */
function openInBrowser(url: string): void {
  try {
    const { protocol } = new URL(url);
    if (protocol === "https:" || protocol === "http:") {
      void shell.openExternal(url);
    }
  } catch {
    // Not a valid URL: ignore it.
  }
}

/** Run before the app is ready: applies to every window we create. */
export function hardenWebContents(): void {
  app.on("web-contents-created", (_event, contents) => {
    // New windows (target="_blank", window.open): never inside the app.
    contents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url);
      return { action: "deny" };
    });

    // The window may only show our own UI. Anything else is blocked (links
    // meant for the browser use target="_blank", handled above).
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });

    // We never use <webview>.
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  });
}

/** Run once the app is ready. */
export function restrictPermissions(): void {
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback) => {
      callback(ALLOWED_PERMISSIONS.has(permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
    ALLOWED_PERMISSIONS.has(permission),
  );
}

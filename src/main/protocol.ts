import { extname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { app, net, protocol } from "electron";

// The built UI is served from app://streamy/ instead of file://. A page on
// file:// can read any file on disk; app:// can only reach the UI folder.
// https://www.electronjs.org/docs/latest/tutorial/security#18-avoid-usage-of-the-file-protocol-and-prefer-usage-of-custom-protocols
//
// What app://streamy/<path> answers, in this order:
//   /api/…               the engine (see engine/proxy.ts)
//   /third-party-notices.txt
//                        THIRD_PARTY_NOTICES.txt, the licences of everything
//                        inside Streamy (Settings → Advanced). It lives outside
//                        the UI folder: see noticesFile()
//   a file (has a ".")   that file from the built UI
//   anything else        index.html: the UI is a single-page app, so routes
//                        like /torrent/abc must survive a reload

const SCHEME = "app";
const HOST = "streamy";

const RENDERER_DIR = join(import.meta.dirname, "../renderer");

/** Where the UI reads THIRD_PARTY_NOTICES.txt from (advanced-section.tsx). */
export const NOTICES_PATH = "/third-party-notices.txt";

/**
 * THIRD_PARTY_NOTICES.txt, made by scripts/notices.mjs. electron-builder
 * puts it in resources/ (extraResources); in dev it's in vendor/ once
 * `npm run notices` has run.
 */
export function noticesFile(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "THIRD_PARTY_NOTICES.txt")
    : join(app.getAppPath(), "vendor", "THIRD_PARTY_NOTICES.txt");
}

/** The Vite dev server (only while running `npm run dev`). */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
}

/** The dev server's origin ("http://localhost:5173"), or undefined. */
export function devServerOrigin(): string | undefined {
  const url = devServerUrl();
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Where the window loads the UI from. */
export function uiUrl(): string {
  return devServerUrl() ?? `${SCHEME}://${HOST}/`;
}

/** True for URLs that belong to our own UI. */
export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // Not `.origin`: for custom schemes like app:// it's always "null".
    if (parsed.protocol === `${SCHEME}:` && parsed.host === HOST) return true;
    const devServer = devServerUrl();
    return (
      devServer !== undefined && parsed.origin === new URL(devServer).origin
    );
  } catch {
    return false;
  }
}

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // In dev the page comes from the Vite server, so its calls to
        // app://streamy/api are cross-origin (see engine/proxy.ts).
        corsEnabled: true,
      },
    },
  ]);
}

export type AppRoute =
  /** For the engine. `path` keeps its encoding and query: "/v1/x?y=1". */
  | { kind: "api"; path: string }
  | { kind: "file"; file: string }
  /** THIRD_PARTY_NOTICES.txt (see noticesFile()). */
  | { kind: "notices" }
  | { kind: "status"; status: 400 | 403 | 404 };

/**
 * What an app:// URL leads to. Nothing outside `rootDir` can be reached,
 * however the URL is written.
 */
export function routeAppRequest(rootDir: string, url: string): AppRoute {
  const parsed = new URL(url);
  if (parsed.host !== HOST) return { kind: "status", status: 404 };

  if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
    const path = parsed.pathname.slice("/api".length) || "/";
    return { kind: "api", path: path + parsed.search };
  }
  if (parsed.pathname === NOTICES_PATH) return { kind: "notices" };

  const resolved = resolveUiFile(rootDir, url);
  if ("status" in resolved) return { kind: "status", status: resolved.status };
  // No extension: a route of the single-page app, not a file.
  if (extname(resolved.file) === "") {
    return { kind: "file", file: join(rootDir, "index.html") };
  }
  return { kind: "file", file: resolved.file };
}

/**
 * The file an app:// URL may serve, or the HTTP status to answer instead.
 * Nothing outside `rootDir` can be reached, however the URL is written.
 */
export function resolveUiFile(
  rootDir: string,
  url: string,
): { file: string } | { status: 400 | 403 | 404 } {
  const parsed = new URL(url);
  if (parsed.host !== HOST) return { status: 404 };

  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { status: 400 };
  }

  const file = join(rootDir, pathname === "/" ? "index.html" : pathname);
  // Block "../" tricks (e.g. %2e%2e%2f) that would escape the UI folder.
  const rel = relative(rootDir, file);
  if (rel.startsWith("..") || isAbsolute(rel)) return { status: 403 };
  return { file };
}

interface AppProtocolOptions {
  /** Answers app://streamy/api/… (the engine proxy). */
  api: (request: Request, path: string) => Promise<Response>;
}

/** Serves the UI and the engine API. Run once the app is ready. */
export function handleAppProtocol({ api }: AppProtocolOptions): void {
  protocol.handle(SCHEME, async (request) => {
    const route = routeAppRequest(RENDERER_DIR, request.url);
    switch (route.kind) {
      case "api":
        return api(request, route.path);
      case "status":
        return new Response(null, { status: route.status });
      case "notices":
        return serveFile(noticesFile());
      case "file":
        return serveFile(route.file);
    }
  });
}

async function serveFile(file: string): Promise<Response> {
  try {
    return await net.fetch(pathToFileURL(file).toString());
  } catch {
    return new Response(null, { status: 404 });
  }
}

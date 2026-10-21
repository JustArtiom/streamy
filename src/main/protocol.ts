import { isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { app, net, protocol } from "electron";

// The built UI is served from app://streamy/ instead of file://. A page on
// file:// can read any file on disk; app:// can only reach the UI folder.
// https://www.electronjs.org/docs/latest/tutorial/security#18-avoid-usage-of-the-file-protocol-and-prefer-usage-of-custom-protocols

const SCHEME = "app";
const HOST = "streamy";

const RENDERER_DIR = join(__dirname, "../renderer");

/** The Vite dev server (only while running `npm run dev`). */
function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
}

/** Where the window loads the UI from. */
export function uiUrl(): string {
  return devServerUrl() ?? `${SCHEME}://${HOST}/index.html`;
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
      },
    },
  ]);
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

/** Serves files from the built UI folder. Run once the app is ready. */
export function handleAppProtocol(): void {
  protocol.handle(SCHEME, (request) => {
    const resolved = resolveUiFile(RENDERER_DIR, request.url);
    if ("status" in resolved) {
      return new Response(null, { status: resolved.status });
    }
    return net.fetch(pathToFileURL(resolved.file).toString());
  });
}

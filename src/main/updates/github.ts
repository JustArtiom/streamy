// Streamy's releases on GitHub: where they are, and (for macOS, which can't
// update itself) which one is the newest.

const OWNER = "JustArtiom";
const REPO = "streamy";

/** The releases list. GitHub sends /latest to the newest published one. */
export const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases`;
export const LATEST_RELEASE_PAGE = `${RELEASES_PAGE}/latest`;

/** GitHub's REST API: the newest release that isn't a draft or a pre-release. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** How long the check may take before it counts as "couldn't reach GitHub". */
export const GITHUB_TIMEOUT_MS = 30_000;

/** "v1.2.3" or "v1.2.3-beta.1": the only tags the release workflow accepts. */
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The page of one release, e.g. …/releases/tag/v1.2.3. Null for an odd tag. */
export function releasePage(tag: string): string | null {
  return TAG.test(tag) ? `${RELEASES_PAGE}/tag/${tag}` : null;
}

/**
 * True only for our own releases pages on GitHub. Checked right before a URL
 * goes to the browser, whatever built it.
 */
export function isOurReleasePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.host === "github.com" &&
      parsed.username === "" &&
      parsed.password === "" &&
      (parsed.pathname === `/${OWNER}/${REPO}/releases` ||
        parsed.pathname.startsWith(`/${OWNER}/${REPO}/releases/`))
    );
  } catch {
    return false;
  }
}

interface Version {
  core: [number, number, number];
  /** "beta.1" → ["beta", "1"]; empty for a normal release. */
  pre: string[];
}

const VERSION =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (!match) return null;
  const [, major, minor, patch, pre] = match;
  return {
    core: [Number(major), Number(minor), Number(patch)],
    pre: pre ? pre.split(".") : [],
  };
}

/**
 * Compares two versions the semver way ("1.2.3", "v1.2.3", "1.2.3-beta.1"):
 * negative if a is older, 0 if the same, positive if a is newer. Null if
 * either isn't a version.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A pre-release comes before its release: 1.0.0-beta < 1.0.0.
  if (left.pre.length === 0 || right.pre.length === 0) {
    return right.pre.length - left.pre.length;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1; // fewer parts come first
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    if (xNumber && yNumber) return Number(x) - Number(y);
    if (xNumber) return -1; // numbers come before words
    if (yNumber) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The newest published release. */
export interface LatestRelease {
  /** "1.2.3" (the tag without its "v"). */
  version: string;
  /** "v1.2.3" */
  tag: string;
}

/** Why asking GitHub failed, so the updater can pick its message. */
export class GitHubCheckError extends Error {
  readonly kind: "offline" | "busy" | "unexpected";

  constructor(kind: GitHubCheckError["kind"], message: string) {
    super(message);
    this.name = "GitHubCheckError";
    this.kind = kind;
  }
}

/**
 * Asks GitHub for the newest release. Null when there's none yet (GitHub
 * answers 404). Throws a GitHubCheckError otherwise. No token: 60 requests
 * an hour per IP address is plenty for a check every few hours.
 */
export async function fetchLatestRelease(
  fetchUrl: (url: string, init: RequestInit) => Promise<Response>,
  appVersion: string,
): Promise<LatestRelease | null> {
  let response: Response;
  try {
    response = await fetchUrl(LATEST_RELEASE_API, {
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        // GitHub rejects API requests without one.
        "user-agent": `Streamy/${appVersion}`,
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GitHubCheckError("offline", describe(error));
  }

  if (response.status === 404) return null;
  // 403 and 429: the rate limit (or GitHub being unwell).
  if (response.status === 403 || response.status === 429) {
    throw new GitHubCheckError("busy", `GitHub answered ${response.status}`);
  }
  if (!response.ok) {
    throw new GitHubCheckError(
      "unexpected",
      `GitHub answered ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new GitHubCheckError("unexpected", describe(error));
  }
  const tag =
    typeof body === "object" && body !== null && "tag_name" in body
      ? body.tag_name
      : undefined;
  if (typeof tag !== "string" || !TAG.test(tag)) {
    throw new GitHubCheckError(
      "unexpected",
      `The newest release has an unexpected tag: ${JSON.stringify(tag)}`,
    );
  }
  return { version: tag.slice(1), tag };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

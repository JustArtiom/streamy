import { randomBytes } from "node:crypto";

/*
 * ffmpeg and ffprobe read torrent files over loopback HTTP, like a browser
 * would: they seek with Range requests and each read makes its pieces
 * urgent. They can't send our secret header, so instead each gets a URL
 * with a random token:
 *
 *   http://127.0.0.1:<port>/internal/files/<token>
 *
 * A token can read only the one file it was made for. Command lines are
 * visible to every program on the computer, so tokens are short-lived:
 * revoked as soon as the probe or playback that needed it ends, and expired
 * after an hour without use, should anything forget to revoke one.
 *
 * Each token also has a gate that can limit how many more bytes its reads
 * get. A playback uses it while its ffmpeg is far ahead of the viewer: the
 * bytes stop flowing and ffmpeg simply waits in read(). That works the same
 * on every OS (Windows can't pause a process).
 */

/** A token unused for this long stops working. */
export const FILE_TOKEN_IDLE_MS = 60 * 60_000;

export type FileTarget = { infoHash: string; fileIndex: number };

/** A URL ffmpeg can read one file with. */
export type InternalFileUrl = {
  url: string;
  /** Marks it as in use (pushes its expiry back). */
  touch(): void;
  /**
   * From now on, reads of this URL get at most `bytes` more bytes (0 =
   * none: they wait), until the next call. null = no limit (the default).
   * Waiting reads just wait; nothing fails.
   */
  allow(bytes: number | null): void;
  /** Stops it working, and ends reads that are waiting. Safe to call twice. */
  revoke(): void;
};

/** What the file route asks before sending each slice of a token's bytes. */
export type ReadGate = {
  /**
   * Resolves once `bytes` more may be sent (and counts them). Rejects when
   * the token is revoked or `signal` aborts (the reader went away).
   */
  pass(bytes: number, signal: AbortSignal): Promise<void>;
};

/** Why a waiting read ended: the token was revoked (its playback stopped). */
export const TOKEN_REVOKED = "TOKEN_REVOKED";

function revokedError(): Error {
  return Object.assign(new Error("This file URL was revoked"), {
    code: TOKEN_REVOKED,
  });
}

type Gate = ReadGate & {
  allow(bytes: number | null): void;
  /** Revoked: wakes waiting reads, which then fail. */
  close(): void;
};

function createGate(): Gate {
  /** Bytes sent so far, over every read of the token. */
  let sent = 0;
  /** `sent` may grow up to this; null = no limit. */
  let until: number | null = null;
  let closed = false;
  const waiters = new Set<() => void>();

  const blocked = () => until !== null && sent >= until && !closed;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  return {
    allow(bytes) {
      until = bytes === null ? null : sent + Math.max(0, bytes);
      if (!blocked()) wake();
    },
    close() {
      closed = true;
      wake();
    },
    async pass(bytes, signal) {
      while (blocked()) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const woken = () => {
            waiters.delete(woken);
            signal.removeEventListener("abort", aborted);
            resolve();
          };
          const aborted = () => {
            waiters.delete(woken);
            reject(signal.reason as Error);
          };
          waiters.add(woken);
          signal.addEventListener("abort", aborted, { once: true });
        });
      }
      if (closed) throw revokedError();
      // A slice may overshoot `until` a little: it's never cut.
      sent += bytes;
    },
  };
}

type Grant = FileTarget & { expiresAt: number; gate: Gate };

const grants = new Map<string, Grant>();
let origin: string | null = null;

/** Where the engine listens, e.g. "http://127.0.0.1:52011". Set once listening. */
export function setInternalOrigin(value: string | null): void {
  origin = value;
}

function drop(token: string, grant: Grant): void {
  grants.delete(token);
  grant.gate.close();
}

function dropExpired(now: number): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) drop(token, grant);
  }
}

/** A new token for reading `target`. */
export function mintFileToken(target: FileTarget): InternalFileUrl {
  if (origin === null) {
    throw new Error("The engine isn't listening yet: no internal URL");
  }
  const now = Date.now();
  dropExpired(now);

  // 32 random bytes: unguessable, and URL-safe as base64url.
  const token = randomBytes(32).toString("base64url");
  const grant: Grant = {
    infoHash: target.infoHash,
    fileIndex: target.fileIndex,
    expiresAt: now + FILE_TOKEN_IDLE_MS,
    gate: createGate(),
  };
  grants.set(token, grant);

  return {
    url: `${origin}/internal/files/${token}`,
    touch() {
      if (grants.get(token) === grant) {
        grant.expiresAt = Date.now() + FILE_TOKEN_IDLE_MS;
      }
    },
    allow(bytes) {
      grant.gate.allow(bytes);
    },
    revoke() {
      if (grants.get(token) === grant) drop(token, grant);
    },
  };
}

/** What `token` may read and its gate (and marks it used), or null if it's not valid. */
export function openFileToken(
  token: string,
): { target: FileTarget; gate: ReadGate } | null {
  const grant = grants.get(token);
  if (!grant) return null;
  const now = Date.now();
  if (grant.expiresAt <= now) {
    drop(token, grant);
    return null;
  }
  grant.expiresAt = now + FILE_TOKEN_IDLE_MS;
  return {
    target: { infoHash: grant.infoHash, fileIndex: grant.fileIndex },
    gate: grant.gate,
  };
}

/** What `token` may read (and marks it used), or null if it's not valid. */
export function resolveFileToken(token: string): FileTarget | null {
  return openFileToken(token)?.target ?? null;
}

/** A torrent went away: none of its tokens work anymore. */
export function revokeTorrentTokens(infoHash: string): void {
  for (const [token, grant] of grants) {
    if (grant.infoHash === infoHash) drop(token, grant);
  }
}

/** Tests and shutdown. */
export function revokeAllFileTokens(): void {
  for (const [token, grant] of grants) drop(token, grant);
}

/** Tests: how many tokens work right now. */
export function activeFileTokenCount(): number {
  dropExpired(Date.now());
  return grants.size;
}

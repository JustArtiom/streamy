/*
 * Removes what must never reach a log file (or an error message the UI
 * shows): the engine's secret, file tokens, and full magnet links.
 *
 * The logger runs every line through redact(), so even a careless log call
 * (an ffmpeg command line, a URL in an error) can't leak them.
 */

// A file token URL: /internal/files/<base64url token>
const FILE_TOKEN = /\/internal\/files\/[A-Za-z0-9_-]+/g;

// A magnet link up to the end of a JSON string or a word.
const MAGNET = /magnet:\?[^\s"'\\<>]*/gi;
const INFO_HASH = /xt=urn:btih:([0-9a-z]+)/i;

const secrets = new Set<string>();

/** Something to cut out of every log line from now on (the engine's secret). */
export function registerSecret(secret: string): void {
  if (secret.length >= 8) secrets.add(secret);
}

/** Tests. */
export function clearSecretsForTests(): void {
  secrets.clear();
}

export function redact(text: string): string {
  let result = text
    .replace(FILE_TOKEN, "/internal/files/[token]")
    // Keep only the info hash: names and trackers say what someone watches.
    .replace(MAGNET, (magnet) => {
      const hash = INFO_HASH.exec(magnet)?.[1];
      return hash ? `magnet:?xt=urn:btih:${hash}` : "magnet:?[redacted]";
    });
  for (const secret of secrets) {
    if (result.includes(secret)) result = result.replaceAll(secret, "[secret]");
  }
  return result;
}

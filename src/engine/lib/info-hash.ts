/**
 * A BitTorrent v1 info hash as the engine keeps it everywhere: 40 lowercase
 * hex characters. Also what makes a file or folder name built from it safe
 * (no "../", no separators). Input from people (any case, base32) is turned
 * into this form by lib/magnet.ts first.
 */
const INFO_HASH = /^[0-9a-f]{40}$/;

export function isInfoHash(value: unknown): value is string {
  return typeof value === "string" && INFO_HASH.test(value);
}

const HEX_HASH = /^[0-9a-f]{40}$/i;
const BASE32_HASH = /^[a-z2-7]{32}$/i;

/** A .torrent file, going by its name (what people can see and fix). */
export function isTorrentFile(file: { name: string }): boolean {
  return file.name.toLowerCase().endsWith(".torrent");
}

/** A torrent's id in URLs: 40 hex characters. */
export function isInfoHash(value: string): boolean {
  return HEX_HASH.test(value);
}

/**
 * A quick check before asking the engine, so obvious typos get an instant
 * answer. The engine still has the final word (it explains what's wrong).
 */
export function checkMagnetInput(input: string): string | null {
  const value = input.trim();
  if (!value) return "Paste a magnet link or an info hash";
  if (HEX_HASH.test(value)) return null;
  if (value.toLowerCase().startsWith("magnet:?")) return null;
  return "That doesn't look like a magnet link (magnet:?xt=…) or a 40-character info hash";
}

/** Looks complete enough to add right away when pasted. */
export function looksLikeMagnet(input: string): boolean {
  const value = input.trim();
  return HEX_HASH.test(value) || /^magnet:\?.*xt=urn:bt(ih|mh):/i.test(value);
}

/** The 40-hex info hash in a magnet link or bare hash, lowercased. */
export function infoHashOf(input: string): string | null {
  const value = input.trim();
  if (HEX_HASH.test(value)) return value.toLowerCase();
  const match = /xt=urn:btih:([0-9a-z]+)/i.exec(value);
  const hash = match?.[1];
  if (!hash) return null;
  if (HEX_HASH.test(hash)) return hash.toLowerCase();
  if (BASE32_HASH.test(hash)) return base32ToHex(hash);
  return null;
}

/** The dn= (display name) of a magnet link, if any. */
export function magnetName(input: string): string | null {
  try {
    const query = input.trim().replace(/^magnet:\?/i, "");
    return new URLSearchParams(query).get("dn") || null;
  } catch {
    return null;
  }
}

function base32ToHex(value: string) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const char of value.toLowerCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  let hex = "";
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.slice(0, 40);
}

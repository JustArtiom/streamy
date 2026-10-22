import { isInfoHash } from "./info-hash";
import { isLocalPeer, isLocalUrl } from "./local-address";

const BTIH = /^urn:btih:([0-9a-f]{40}|[a-z2-7]{32})$/i;
const BTMH = /^urn:btmh:/i;

/**
 * The magnet parameters Streamy passes on: the info hash, the name, and
 * where to find peers (trackers, web seeds, peers by address). Everything
 * else is dropped. In particular `xs` and `as`: WebTorrent would download
 * whatever those URLs point at (with no size limit) or use them as web
 * seeds.
 */
const KEPT_PARAMS = new Set(["xt", "dn", "tr", "ws", "x.pe"]);

export type MagnetOptions = {
  /**
   * Keep trackers, web seeds and peers on this computer or the local
   * network. Only in test mode (the e2e seeder is on 127.0.0.1).
   */
  allowLocalAddresses?: boolean;
};

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Whether one `key=value` of a magnet goes on to WebTorrent. Values are
 * checked the way WebTorrent's magnet parser reads them: `tr`, `ws` and
 * `dn` URL-decoded (a broken one would make it reject the whole link),
 * `x.pe` as it is.
 */
function keepParam(key: string, value: string, allowLocal: boolean): boolean {
  if (!KEPT_PARAMS.has(key)) return false;
  switch (key) {
    case "dn":
      return decoded(value) !== null;
    case "tr":
    case "ws": {
      const url = decoded(value);
      return url !== null && (allowLocal || !isLocalUrl(url));
    }
    case "x.pe":
      return allowLocal || !isLocalPeer(value);
    default:
      return true;
  }
}

/** The magnet rebuilt from the parameters Streamy keeps (KEPT_PARAMS). */
function cleanMagnet(magnet: string, allowLocal: boolean): string {
  const params = magnet
    .slice("magnet:?".length)
    .split("&")
    .filter((param) => {
      // WebTorrent's parser skips anything that isn't exactly key=value.
      const parts = param.split("=");
      if (parts.length !== 2) return false;
      const [key = "", value = ""] = parts;
      return keepParam(key, value, allowLocal);
    });
  return `magnet:?${params.join("&")}`;
}

/**
 * Checks what the user pasted: a magnet link with a BitTorrent v1 info hash
 * (40 hex or 32 base32 chars), or a bare 40-char hex info hash.
 * Returns the magnet link to add (only the parameters Streamy uses, see
 * KEPT_PARAMS), or a message saying what's wrong.
 */
export function parseMagnetInput(
  input: string,
  { allowLocalAddresses = false }: MagnetOptions = {},
): { magnet: string } | { error: string } {
  const value = input.trim();

  if (isInfoHash(value.toLowerCase())) {
    return { magnet: `magnet:?xt=urn:btih:${value.toLowerCase()}` };
  }

  if (!value.toLowerCase().startsWith("magnet:?")) {
    return {
      error:
        "Paste a magnet link (magnet:?xt=urn:btih:…) or a 40-character info hash",
    };
  }

  const topics = new URLSearchParams(value.slice("magnet:?".length)).getAll(
    "xt",
  );
  if (topics.some((topic) => BTIH.test(topic))) {
    return { magnet: cleanMagnet(value, allowLocalAddresses) };
  }

  // v2 torrents use a different hash (btmh). Hybrid magnets carry both and
  // work; v2-only ones would need a v2 client.
  if (topics.some((topic) => BTMH.test(topic))) {
    return { error: "BitTorrent v2-only magnets aren't supported yet" };
  }
  return { error: "This magnet link has no BitTorrent info hash" };
}

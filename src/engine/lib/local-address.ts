import { isIPv4, isIPv6 } from "node:net";

/*
 * Is a tracker, web seed or peer address on this computer or the local
 * network? A magnet link is something a web page can hand Streamy with one
 * click, so the hosts it names mustn't include the user's router, NAS or
 * a server on 127.0.0.1: the engine would send them requests (tracker
 * announces and web seed GETs are plain HTTP requests to a URL the link
 * chooses).
 *
 * Only what the address itself says is checked. A public name that
 * resolves to a local address isn't caught (that would need a check where
 * WebTorrent connects).
 */

/** Names that only mean something on the local network. */
const LOCAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".lan",
  ".home",
  ".internal",
  ".home.arpa",
];

/** The IPv4 blocks that aren't on the public internet. */
function isLocalIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 || // "this network" (0.0.0.0 reaches this computer on Linux)
    a === 10 || // private (RFC 1918)
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT, VPNs)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The 8 groups of an IPv6 address, or null if it isn't one. */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((group) => Number.parseInt(group, 16)) : [];
  const head = parse(halves[0]);
  const tail = parse(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array<number>(missing).fill(0), ...tail];
  return groups.every((group) => Number.isInteger(group)) ? groups : null;
}

function isLocalIPv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return true; // not understood: not trusted either
  const [first = 0, , , , , sixth = 0, high = 0, low = 0] = groups;
  if (groups.slice(0, 5).every((group) => group === 0)) {
    // ::, ::1 and the old ::a.b.c.d: never a public peer.
    if (sixth === 0) return true;
    // An IPv4 address written as IPv6 (::ffff:a.b.c.d).
    if (sixth === 0xffff) {
      return isLocalIPv4(
        [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."),
      );
    }
  }
  return (
    (first & 0xfe00) === 0xfc00 || // unique local (fc00::/7)
    (first & 0xffc0) === 0xfe80 || // link-local (fe80::/10)
    (first & 0xffc0) === 0xfec0 || // old site-local (fec0::/10)
    (first & 0xff00) === 0xff00 // multicast
  );
}

/**
 * `host` as a URL would carry it ("127.0.0.1", "[::1]", "nas.local").
 * Odd ways of writing an address ("127.1", "0x7f000001") are read the way
 * the system would connect to them, so they can't slip through.
 */
export function isLocalHost(host: string): boolean {
  let name: string;
  try {
    name = new URL(`http://${host}/`).hostname;
  } catch {
    return true; // can't be read: not trusted
  }
  if (name.startsWith("[") && name.endsWith("]")) {
    return isLocalIPv6(name.slice(1, -1));
  }
  name = name.replace(/\.$/, ""); // "localhost." is localhost
  if (isIPv4(name)) return isLocalIPv4(name);
  if (isIPv6(name)) return isLocalIPv6(name);
  // A single label ("localhost", "router", "nas") is looked up on the
  // local network.
  if (!name.includes(".")) return true;
  return LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A tracker or web seed URL whose host is local (or that can't be read). */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return true;
  }
  return host === "" || isLocalHost(host);
}

/** A peer "host:port" ("[v6]:port") that is local, or isn't an address. */
export function isLocalPeer(address: string): boolean {
  const match = /^(\[[^\]]+\]|[^:[\]]+):(\d{1,5})$/.exec(address);
  if (!match?.[1]) return true;
  return isLocalHost(match[1]);
}

import { describe, expect, it } from "vitest";
import { isLocalHost, isLocalPeer, isLocalUrl } from "./local-address";

describe("isLocalHost", () => {
  it.each([
    // This computer.
    "127.0.0.1",
    "127.8.9.10",
    "localhost",
    "LOCALHOST.",
    "app.localhost",
    "[::1]",
    "[::]",
    "0.0.0.0",
    // Written oddly, read the way the system would connect.
    "127.1",
    "0x7f000001",
    "2130706433",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    // The local network.
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "[fd12:3456::1]",
    "[fe80::1]",
    "[::ffff:192.168.1.1]",
    "nas",
    "router.local",
    "printer.lan",
    "box.home.arpa",
    "db.internal",
    // Multicast and broadcast.
    "224.0.0.1",
    "255.255.255.255",
    "[ff02::1]",
  ])("%s is local", (host) => {
    expect(isLocalHost(host)).toBe(true);
  });

  it.each([
    "tracker.opentrackr.org",
    "93.184.216.34",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "[2001:db8::1]",
    "[2606:4700::6810:84e5]",
    "[::ffff:93.184.216.34]",
    "my.localhost.example.com",
  ])("%s is public", (host) => {
    expect(isLocalHost(host)).toBe(false);
  });
});

describe("isLocalUrl", () => {
  it.each([
    ["udp://tracker.opentrackr.org:1337/announce", false],
    ["wss://tracker.openwebtorrent.com", false],
    ["https://webtorrent.io/torrents/", false],
    ["http://127.0.0.1:8000/announce", true],
    ["udp://127.1:6969", true],
    ["http://[::1]/x", true],
    ["http://nas.local/movie.mkv", true],
    ["not a url", true],
    ["file:///etc/passwd", true],
  ])("%s → %s", (url, local) => {
    expect(isLocalUrl(url)).toBe(local);
  });
});

describe("isLocalPeer", () => {
  it.each([
    ["203.0.113.5:6881", false],
    ["[2001:db8::1]:6881", false],
    ["peer.example.com:6881", false],
    ["127.0.0.1:6881", true],
    ["[::1]:6881", true],
    ["192.168.0.10:51413", true],
    ["localhost:6881", true],
    ["127.0.0.1%3A6881", true],
    ["no-port", true],
    ["1.2.3.4:", true],
  ])("%s → %s", (address, local) => {
    expect(isLocalPeer(address)).toBe(local);
  });
});

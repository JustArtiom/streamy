import { describe, expect, it } from "vitest";
import { parseMagnetInput } from "./magnet";

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
const SINTEL = `magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969`;

describe("parseMagnetInput", () => {
  it("accepts a magnet link as is", () => {
    expect(parseMagnetInput(SINTEL)).toEqual({ magnet: SINTEL });
  });

  it("trims whitespace around a pasted link", () => {
    expect(parseMagnetInput(`  ${SINTEL}\n`)).toEqual({ magnet: SINTEL });
  });

  it("turns a bare info hash into a magnet link (lower-cased)", () => {
    expect(parseMagnetInput(HASH.toUpperCase())).toEqual({
      magnet: `magnet:?xt=urn:btih:${HASH}`,
    });
  });

  it("accepts a base32 info hash", () => {
    const magnet = "magnet:?xt=urn:btih:BCW2LJ5GDA5K4HQJ3AY56Z2I2VTAVIQQ";
    expect(parseMagnetInput(magnet)).toEqual({ magnet });
  });

  it("accepts a hybrid v1+v2 magnet", () => {
    const magnet = `magnet:?xt=urn:btih:${HASH}&xt=urn:btmh:1220${"a".repeat(64)}`;
    expect(parseMagnetInput(magnet)).toEqual({ magnet });
  });

  it("rejects a v2-only magnet with a clear message", () => {
    expect(
      parseMagnetInput(`magnet:?xt=urn:btmh:1220${"a".repeat(64)}`),
    ).toEqual({ error: "BitTorrent v2-only magnets aren't supported yet" });
  });

  it.each([
    "magnet:?dn=NoHash",
    "magnet:?xt=urn:btih:tooshort",
    `magnet:?xt=urn:btih:${"z".repeat(40)}`,
    "magnet:?xt=urn:sha1:abc",
  ])("rejects %s (no usable info hash)", (input) => {
    expect(parseMagnetInput(input)).toEqual({
      error: "This magnet link has no BitTorrent info hash",
    });
  });

  it.each(["", "hello", "https://example.com/a.torrent", HASH.slice(1)])(
    "rejects %j",
    (input) => {
      expect(parseMagnetInput(input)).toHaveProperty("error");
    },
  );

  it("keeps only xt, dn, tr, ws and x.pe", () => {
    const magnet =
      `magnet:?xt=urn:btih:${HASH}&dn=Sintel` +
      "&xs=https%3A%2F%2Fexample.com%2Fsintel.torrent" +
      "&as=https%3A%2F%2Fexample.com%2Fsintel" +
      "&tr=udp%3A%2F%2Fexplodie.org%3A6969" +
      "&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F" +
      "&x.pe=203.0.113.5:6881&so=0-3&kt=a+b&xl=10&junk";

    expect(parseMagnetInput(magnet)).toEqual({
      magnet:
        `magnet:?xt=urn:btih:${HASH}&dn=Sintel` +
        "&tr=udp%3A%2F%2Fexplodie.org%3A6969" +
        "&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F" +
        "&x.pe=203.0.113.5:6881",
    });
  });

  it("drops trackers, web seeds and peers on this computer or the local network", () => {
    const local =
      `magnet:?xt=urn:btih:${HASH}` +
      "&tr=http%3A%2F%2F127.0.0.1%3A8000%2Fannounce" +
      "&tr=udp%3A%2F%2Frouter.local%3A1" +
      "&ws=http%3A%2F%2F192.168.1.1%2Fadmin" +
      "&x.pe=127.0.0.1:6881&x.pe=[fe80::1]:6881&x.pe=10.0.0.5:51413";

    expect(parseMagnetInput(local)).toEqual({
      magnet: `magnet:?xt=urn:btih:${HASH}`,
    });
    // Test mode: the e2e seeder is on 127.0.0.1.
    expect(parseMagnetInput(local, { allowLocalAddresses: true })).toEqual({
      magnet: local,
    });
  });

  it("drops a parameter WebTorrent couldn't read (it would refuse the whole link)", () => {
    expect(
      parseMagnetInput(
        `magnet:?xt=urn:btih:${HASH}&dn=%E0%A4%A&tr=udp%3A%2F%2F%ZZ&x.pe=a=b`,
      ),
    ).toEqual({ magnet: `magnet:?xt=urn:btih:${HASH}` });
  });

  it("accepts any case of 'magnet:'", () => {
    expect(parseMagnetInput(`MAGNET:?xt=urn:btih:${HASH}`)).toEqual({
      magnet: `magnet:?xt=urn:btih:${HASH}`,
    });
  });
});

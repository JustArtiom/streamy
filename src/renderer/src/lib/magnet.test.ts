import { describe, expect, it } from "vitest";
import {
  checkMagnetInput,
  infoHashOf,
  isInfoHash,
  isTorrentFile,
  looksLikeMagnet,
  magnetName,
} from "@/lib/magnet";

const HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";
// The same hash in base32, as some magnet links carry it.
const BASE32 = "BCW2LJ5GDA5K4HQJ3AY56Z2I2VTASWQQ";
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969`;

describe("checkMagnetInput", () => {
  it("accepts magnet links and bare info hashes", () => {
    expect(checkMagnetInput(MAGNET)).toBeNull();
    expect(checkMagnetInput(HASH)).toBeNull();
    expect(checkMagnetInput(HASH.toUpperCase())).toBeNull();
    expect(checkMagnetInput(`  ${MAGNET}\n`)).toBeNull();
    expect(checkMagnetInput("MAGNET:?xt=urn:btih:abc")).toBeNull();
  });

  it("asks for something when it's empty", () => {
    expect(checkMagnetInput("")).toBe("Paste a magnet link or an info hash");
    expect(checkMagnetInput("   ")).toBe("Paste a magnet link or an info hash");
  });

  it("explains anything else", () => {
    expect(checkMagnetInput("https://example.com/a.torrent")).toMatch(
      /doesn't look like a magnet link/,
    );
    expect(checkMagnetInput(HASH.slice(1))).toMatch(/40-character info hash/);
  });
});

describe("looksLikeMagnet", () => {
  it("is true for complete-looking magnets and hashes", () => {
    expect(looksLikeMagnet(MAGNET)).toBe(true);
    expect(looksLikeMagnet(HASH)).toBe(true);
    expect(looksLikeMagnet("magnet:?xt=urn:btmh:1220abcd")).toBe(true);
  });

  it("is false for partial or unrelated text", () => {
    expect(looksLikeMagnet("magnet:?dn=Sintel")).toBe(false);
    expect(looksLikeMagnet("hello")).toBe(false);
    expect(looksLikeMagnet("")).toBe(false);
  });
});

describe("infoHashOf", () => {
  it("reads hex hashes, lowercased", () => {
    expect(infoHashOf(HASH.toUpperCase())).toBe(HASH);
    expect(infoHashOf(MAGNET)).toBe(HASH);
    expect(infoHashOf(MAGNET.replace(HASH, HASH.toUpperCase()))).toBe(HASH);
  });

  it("converts base32 hashes to hex", () => {
    expect(infoHashOf(`magnet:?xt=urn:btih:${BASE32}&dn=Sintel`)).toBe(HASH);
  });

  it("is null without a v1 hash", () => {
    expect(infoHashOf("magnet:?xt=urn:btmh:1220abcd")).toBeNull();
    expect(infoHashOf("magnet:?xt=urn:btih:tooshort")).toBeNull();
    expect(infoHashOf("hello")).toBeNull();
  });
});

describe("magnetName", () => {
  it("reads and decodes dn=", () => {
    expect(magnetName(MAGNET)).toBe("Sintel");
    expect(magnetName(`magnet:?xt=urn:btih:${HASH}&dn=Big+Buck%20Bunny`)).toBe(
      "Big Buck Bunny",
    );
  });

  it("is null when there's no name", () => {
    expect(magnetName(`magnet:?xt=urn:btih:${HASH}`)).toBeNull();
    expect(magnetName(`magnet:?xt=urn:btih:${HASH}&dn=`)).toBeNull();
    expect(magnetName(HASH)).toBeNull();
  });
});

describe("isInfoHash", () => {
  it("is 40 hex characters", () => {
    expect(isInfoHash(HASH)).toBe(true);
    expect(isInfoHash(HASH.slice(1))).toBe(false);
    expect(isInfoHash(BASE32)).toBe(false);
  });
});

describe("isTorrentFile", () => {
  it("goes by the file name", () => {
    expect(isTorrentFile({ name: "Sintel.torrent" })).toBe(true);
    expect(isTorrentFile({ name: "SINTEL.TORRENT" })).toBe(true);
    expect(isTorrentFile({ name: "Sintel.mkv" })).toBe(false);
  });
});

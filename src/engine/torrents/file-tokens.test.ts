import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeFileTokenCount,
  FILE_TOKEN_IDLE_MS,
  mintFileToken,
  openFileToken,
  resolveFileToken,
  revokeAllFileTokens,
  revokeTorrentTokens,
  setInternalOrigin,
} from "./file-tokens";

const A = "a".repeat(40);
const B = "b".repeat(40);

function tokenOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setInternalOrigin("http://127.0.0.1:9999");
});

afterEach(() => {
  vi.useRealTimers();
  revokeAllFileTokens();
  setInternalOrigin(null);
});

describe("file tokens", () => {
  it("makes a different 32-byte base64url token each time", () => {
    const one = mintFileToken({ infoHash: A, fileIndex: 0 });
    const two = mintFileToken({ infoHash: A, fileIndex: 0 });

    expect(one.url).toMatch(
      /^http:\/\/127\.0\.0\.1:9999\/internal\/files\/[A-Za-z0-9_-]{43}$/,
    );
    expect(tokenOf(one.url)).not.toBe(tokenOf(two.url));
    expect(Buffer.from(tokenOf(one.url), "base64url")).toHaveLength(32);
  });

  it("resolves to the one file it was made for", () => {
    const { url } = mintFileToken({ infoHash: A, fileIndex: 3 });
    expect(resolveFileToken(tokenOf(url))).toEqual({
      infoHash: A,
      fileIndex: 3,
    });
    expect(resolveFileToken("made-up")).toBeNull();
  });

  it("stops working when revoked (twice is fine)", () => {
    const internal = mintFileToken({ infoHash: A, fileIndex: 0 });
    internal.revoke();
    internal.revoke();
    expect(resolveFileToken(tokenOf(internal.url))).toBeNull();
  });

  it("expires an hour after its last use; use and touch() push that back", () => {
    const used = mintFileToken({ infoHash: A, fileIndex: 0 });
    const touched = mintFileToken({ infoHash: A, fileIndex: 1 });
    const idle = mintFileToken({ infoHash: A, fileIndex: 2 });

    vi.advanceTimersByTime(FILE_TOKEN_IDLE_MS - 1000);
    expect(resolveFileToken(tokenOf(used.url))).not.toBeNull();
    touched.touch();

    vi.advanceTimersByTime(2000);
    expect(resolveFileToken(tokenOf(idle.url))).toBeNull();
    expect(resolveFileToken(tokenOf(used.url))).not.toBeNull();
    expect(resolveFileToken(tokenOf(touched.url))).not.toBeNull();

    vi.advanceTimersByTime(FILE_TOKEN_IDLE_MS + 1);
    expect(activeFileTokenCount()).toBe(0);
  });

  it("revokes all of a torrent's tokens at once", () => {
    const a = mintFileToken({ infoHash: A, fileIndex: 0 });
    const b = mintFileToken({ infoHash: B, fileIndex: 0 });

    revokeTorrentTokens(A);

    expect(resolveFileToken(tokenOf(a.url))).toBeNull();
    expect(resolveFileToken(tokenOf(b.url))).not.toBeNull();
  });

  it("can't be made before the engine listens", () => {
    setInternalOrigin(null);
    expect(() => mintFileToken({ infoHash: A, fileIndex: 0 })).toThrow(
      "isn't listening",
    );
  });

  describe("the gate (throttling a playback's reads)", () => {
    const gateOf = (url: string) => {
      const gate = openFileToken(tokenOf(url))?.gate;
      if (!gate) throw new Error("no gate");
      return gate;
    };
    const signal = () => new AbortController().signal;

    it("lets everything through until told otherwise", async () => {
      const internal = mintFileToken({ infoHash: A, fileIndex: 0 });
      await gateOf(internal.url).pass(10 ** 9, signal());
    });

    it("holds reads once the allowance is used, and lets them on when allowed more", async () => {
      const internal = mintFileToken({ infoHash: A, fileIndex: 0 });
      const gate = gateOf(internal.url);
      internal.allow(100);
      await gate.pass(60, signal());
      await gate.pass(60, signal()); // a slice may overshoot a little
      let passed = false;
      const waiting = gate.pass(10, signal()).then(() => {
        passed = true;
      });
      await Promise.resolve();
      expect(passed).toBe(false);

      internal.allow(0); // still held
      await Promise.resolve();
      expect(passed).toBe(false);

      internal.allow(50);
      await waiting;
      expect(passed).toBe(true);
    });

    it("ends a held read when the token is revoked, or the reader leaves", async () => {
      const internal = mintFileToken({ infoHash: A, fileIndex: 0 });
      const gate = gateOf(internal.url);
      internal.allow(0);
      const revoked = gate.pass(1, signal());
      internal.revoke();
      await expect(revoked).rejects.toMatchObject({ code: "TOKEN_REVOKED" });

      const other = mintFileToken({ infoHash: A, fileIndex: 0 });
      const gone = new AbortController();
      other.allow(0);
      const left = gateOf(other.url).pass(1, gone.signal);
      gone.abort(new Error("reader left"));
      await expect(left).rejects.toThrow("reader left");
    });

    it("is per token: another token of the same file isn't held", async () => {
      const held = mintFileToken({ infoHash: A, fileIndex: 0 });
      const probe = mintFileToken({ infoHash: A, fileIndex: 0 });
      held.allow(0);
      await gateOf(probe.url).pass(10 ** 6, signal());
    });
  });
});

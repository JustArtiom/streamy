import { describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  fetchLatestRelease,
  GitHubCheckError,
  isOurReleasePage,
  LATEST_RELEASE_API,
  releasePage,
} from "./github";

describe("compareVersions", () => {
  it.each([
    ["0.2.0", "0.1.0", 1],
    ["0.1.1", "0.1.0", 1],
    ["1.0.0", "0.99.99", 1],
    ["0.10.0", "0.9.0", 1],
    ["v0.2.0", "0.2.0", 0],
    ["0.1.0", "0.2.0", -1],
    ["1.0.0", "1.0.0-beta.2", 1],
    ["1.0.0-beta.2", "1.0.0-beta.10", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
    ["1.0.0-alpha.1", "1.0.0-alpha", 1],
    ["1.0.0-1", "1.0.0-alpha", -1],
    ["1.0.0+build.5", "1.0.0", 0],
  ])("%s vs %s → %i", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b) ?? NaN)).toBe(sign);
  });

  it("returns null for things that aren't versions", () => {
    expect(compareVersions("latest", "0.1.0")).toBeNull();
    expect(compareVersions("0.1", "0.1.0")).toBeNull();
  });
});

describe("release pages", () => {
  it("builds a release's page from its tag", () => {
    expect(releasePage("v1.2.3")).toBe(
      "https://github.com/JustArtiom/streamy/releases/tag/v1.2.3",
    );
    expect(releasePage("v1.2.3-beta.1")).toBe(
      "https://github.com/JustArtiom/streamy/releases/tag/v1.2.3-beta.1",
    );
  });

  it.each(["1.2.3", "v1.2", "v1.2.3/../../evil", "v1.2.3?x=1", ""])(
    "refuses the tag %j",
    (tag) => {
      expect(releasePage(tag)).toBeNull();
    },
  );

  it.each([
    "https://github.com/JustArtiom/streamy/releases",
    "https://github.com/JustArtiom/streamy/releases/latest",
    "https://github.com/JustArtiom/streamy/releases/tag/v1.2.3",
  ])("trusts %s", (url) => {
    expect(isOurReleasePage(url)).toBe(true);
  });

  it.each([
    "http://github.com/JustArtiom/streamy/releases",
    "https://github.com/JustArtiom/streamy-fake/releases",
    "https://github.com/JustArtiom/streamy/releasesX",
    "https://github.com/someone/streamy/releases",
    "https://github.com.evil.example/JustArtiom/streamy/releases",
    "https://user@github.com/JustArtiom/streamy/releases",
    "file:///JustArtiom/streamy/releases",
    "not a url",
  ])("doesn't trust %s", (url) => {
    expect(isOurReleasePage(url)).toBe(false);
  });
});

describe("fetchLatestRelease (macOS)", () => {
  const answer = (status: number, body?: unknown) =>
    vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(
        body === undefined
          ? new Response(null, { status })
          : Response.json(body, { status }),
      ),
    );

  it("asks GitHub's API for the latest release, without a token", async () => {
    const fetchUrl = answer(200, { tag_name: "v0.3.0", draft: false });

    expect(await fetchLatestRelease(fetchUrl, "0.2.0")).toEqual({
      version: "0.3.0",
      tag: "v0.3.0",
    });
    const [url, init] = fetchUrl.mock.calls[0] ?? [];
    expect(url).toBe(LATEST_RELEASE_API);
    const headers = new Headers(init?.headers);
    expect(headers.get("user-agent")).toBe("Streamy/0.2.0");
    expect(headers.get("authorization")).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null while there's no release (404)", async () => {
    expect(
      await fetchLatestRelease(answer(404, { message: "Not Found" }), "0.1.0"),
    ).toBeNull();
  });

  it.each([
    ["offline", () => Promise.reject(new TypeError("fetch failed"))],
    ["busy", answer(403, { message: "API rate limit exceeded" })],
    ["busy", answer(429)],
    ["unexpected", answer(500)],
    ["unexpected", answer(200, { tag_name: "nightly" })],
    ["unexpected", answer(200, ["not", "a", "release"])],
    [
      "unexpected",
      () => Promise.resolve(new Response("<html>", { status: 200 })),
    ],
  ] as const)("fails as %j", async (kind, fetchUrl) => {
    const result = fetchLatestRelease(fetchUrl, "0.1.0");
    await expect(result).rejects.toBeInstanceOf(GitHubCheckError);
    await expect(result).rejects.toMatchObject({ kind });
  });
});

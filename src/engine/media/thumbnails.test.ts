import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  type LibraryStore,
  openInMemoryLibrary,
  type ProgressEntry,
} from "../library";
import { findFfmpeg } from "../test/runtime";
import type { InternalFileUrl } from "../torrents/file-tokens";
import { runningChildCount, setChildReporter } from "./children";
import { type ServedFile, serveFile } from "./test-media";
import {
  createThumbnailMaker,
  positionOf,
  seekPosition,
  THUMBNAIL_REFRESH_SECONDS,
  THUMBNAIL_RETRY_MS,
  type ThumbnailDeps,
  thumbnailArgs,
  withPositionComment,
} from "./thumbnails";

const binaries = findFfmpeg();
const A = "a".repeat(40);
const B = "b".repeat(40);

/** A real (tiny) JPEG made by ffmpeg, or null without ffmpeg. */
function makeJpeg(ffmpeg: string): Buffer {
  // prettier-ignore
  return execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=64x36:d=1", "-frames:v", "1",
    "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
  ]);
}

describe("the position inside the JPEG", () => {
  it.runIf(binaries)("goes in after the JFIF header and reads back", () => {
    const jpeg = makeJpeg(binaries?.ffmpeg ?? "ffmpeg");
    expect(positionOf(jpeg)).toBeNull();

    const marked = withPositionComment(jpeg, 1234.5678);

    expect(positionOf(marked)).toBe(1234.568);
    expect(marked.subarray(0, 4)).toEqual(jpeg.subarray(0, 4)); // SOI, APP0
    expect(marked.length).toBe(
      jpeg.length + 4 + "streamy-position=1234.568".length,
    );
  });

  it("is null for something that isn't a JPEG", () => {
    expect(positionOf(Buffer.from("hello, world"))).toBeNull();
    expect(positionOf(Buffer.alloc(0))).toBeNull();
  });
});

describe("seekPosition and thumbnailArgs", () => {
  it("keeps the frame a second off the end", () => {
    expect(seekPosition(40, 600)).toBe(40);
    expect(seekPosition(600, 600)).toBe(599);
    expect(seekPosition(40, null)).toBe(40);
    expect(seekPosition(-1, null)).toBe(0);
  });

  it("seeks before -i, grabs one frame 480 px wide at quality 4", () => {
    const args = thumbnailArgs("http://127.0.0.1:1/internal/files/x", 42);
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    // Only real containers over http: never a playlist that fetches URLs.
    expect(args.indexOf("-format_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("http,tcp");
    expect(args.join(" ")).toContain(
      "-ss 42.000 -i http://127.0.0.1:1/internal/files/x",
    );
    expect(args.join(" ")).toContain("-frames:v 1 -vf scale=480:-2 -q:v 4");
    expect(args.at(-1)).toBe("pipe:1");
  });
});

describe.runIf(binaries)("making thumbnails (real ffmpeg)", () => {
  const ffmpeg = binaries?.ffmpeg ?? "ffmpeg";
  const ffprobe = binaries?.ffprobe ?? "ffprobe";
  let dir: string;
  /** The clip, over http like a token URL. */
  let clip: ServedFile;
  let library: LibraryStore;
  let clock: number;
  /** ffmpeg runs started, and the most running at once. */
  let spawned: number;
  let mostAtOnce: number;
  let revoked: number;
  /** An HTTP server that never answers (a torrent with no peers). */
  let stuck: Server;
  let stuckUrl: string;

  function input(url: string): InternalFileUrl {
    return {
      url,
      touch: () => undefined,
      allow: () => undefined,
      revoke: () => {
        revoked += 1;
      },
    };
  }

  function maker(overrides: Partial<ThumbnailDeps> = {}) {
    return createThumbnailMaker({
      ffmpegPath: () => ffmpeg,
      library,
      openInput: () => input(clip.url),
      canRun: () => true,
      now: () => clock,
      ...overrides,
    });
  }

  function save(
    position: number,
    infoHash = A,
    watched?: boolean,
  ): ProgressEntry {
    return library.saveProgress({
      infoHash,
      fileIndex: 0,
      fileName: "Clip.mp4",
      position,
      duration: 600, // the clip's length
      watched,
    });
  }

  const thumbnail = (infoHash = A) => library.thumbnailPath(infoHash, 0);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "streamy-thumbnails-"));
    const file = join(dir, "clip.mp4");
    // prettier-ignore
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=320x180:r=2:d=600",
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "50",
      "-pix_fmt", "yuv420p", file,
    ]);
    clip = await serveFile(file, "clip.mp4");
    stuck = createServer(() => undefined); // never answers
    await new Promise<void>((resolve) => stuck.listen(0, "127.0.0.1", resolve));
    stuckUrl = `http://127.0.0.1:${(stuck.address() as AddressInfo).port}/x`;
  });

  afterAll(async () => {
    stuck.closeAllConnections();
    stuck.close();
    await clip.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    library = openInMemoryLibrary({
      logger: { info: () => undefined, warn: () => undefined },
      thumbnailsDir: join(dir, `thumbnails-${Math.random()}`),
    });
    library.recordTorrent({ infoHash: A, name: "Clip" });
    library.recordTorrent({ infoHash: B, name: "Other" });
    clock = Date.UTC(2026, 0, 1);
    spawned = 0;
    mostAtOnce = 0;
    revoked = 0;
    let alive = 0;
    setChildReporter((_pid, isAlive) => {
      if (isAlive) spawned += 1;
      alive += isAlive ? 1 : -1;
      mostAtOnce = Math.max(mostAtOnce, alive);
    });
  });

  afterEach(() => {
    setChildReporter(null);
    library.close();
    expect(runningChildCount()).toBe(0);
  });

  it("makes one past 30 s: 480 px wide, marked with its position, written whole", async () => {
    const thumbnails = maker();
    thumbnails.consider(save(10)); // too early
    await thumbnails.idle();
    expect(spawned).toBe(0);

    thumbnails.consider(save(40));
    await thumbnails.idle();

    expect(spawned).toBe(1);
    expect(revoked).toBe(1); // the token goes once ffmpeg is done
    const size = execFileSync(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      thumbnail(),
    ])
      .toString()
      .trim();
    expect(size).toBe("480,270");
    expect(positionOf(readFileSync(thumbnail()))).toBe(40);
  });

  it("remakes it only once the position moved more than 5 minutes", async () => {
    const thumbnails = maker();
    thumbnails.consider(save(40));
    await thumbnails.idle();

    thumbnails.consider(save(40 + THUMBNAIL_REFRESH_SECONDS - 1));
    await thumbnails.idle();
    expect(spawned).toBe(1);

    thumbnails.consider(save(40 + THUMBNAIL_REFRESH_SECONDS + 1));
    await thumbnails.idle();
    expect(spawned).toBe(2);
    expect(positionOf(readFileSync(thumbnail()))).toBe(341);
  });

  it("knows an existing thumbnail's position after a restart (no new ffmpeg)", async () => {
    const first = maker();
    first.consider(save(40));
    await first.idle();
    spawned = 0;

    const restarted = maker();
    restarted.consider(save(45));
    await restarted.idle();

    expect(spawned).toBe(0);
  });

  it("skips watched files, a full disk, and torrents that aren't active", async () => {
    maker().consider(save(50, A, true));
    const full = maker({ canRun: () => false });
    full.consider(save(50, B));
    const inactive = maker({
      openInput: () => {
        throw new Error("Torrent not found");
      },
    });
    inactive.consider(save(55, B));
    await Promise.all([full.idle(), inactive.idle()]);

    expect(spawned).toBe(0);
    expect(existsSync(thumbnail(A))).toBe(false);
    expect(existsSync(thumbnail(B))).toBe(false);
  });

  it("runs one ffmpeg at a time", async () => {
    const thumbnails = maker();
    thumbnails.consider(save(40, A));
    thumbnails.consider(save(40, B));
    await thumbnails.idle();

    expect(spawned).toBe(2);
    expect(mostAtOnce).toBe(1);
  });

  it("after a failure, waits 2 minutes before trying that file again", async () => {
    const thumbnails = maker({
      openInput: () => input(clip.url.replace("clip.mp4", "missing.mp4")),
    });
    thumbnails.consider(save(40));
    await thumbnails.idle();
    thumbnails.consider(save(45));
    await thumbnails.idle();
    expect(spawned).toBe(1);

    clock += THUMBNAIL_RETRY_MS + 1;
    thumbnails.consider(save(50));
    await thumbnails.idle();
    expect(spawned).toBe(2);
    expect(existsSync(thumbnail())).toBe(false);
  });

  it("gives up on a stuck read after its timeout", async () => {
    const thumbnails = maker({
      openInput: () => input(stuckUrl),
      timeoutMs: 300,
    });
    thumbnails.consider(save(40));
    await thumbnails.idle();

    expect(spawned).toBe(1);
    expect(existsSync(thumbnail())).toBe(false);
  });

  it("writes nothing for a file forgotten while ffmpeg ran", async () => {
    const thumbnails = maker({
      ffmpegPath: () => {
        library.deleteProgress(A, 0); // the user removed it meanwhile
        return ffmpeg;
      },
    });
    thumbnails.consider(save(40));
    await thumbnails.idle();

    expect(spawned).toBe(1);
    expect(existsSync(thumbnail())).toBe(false);
  });

  it("kills a running ffmpeg at shutdown, and does nothing after", async () => {
    const thumbnails = maker({ openInput: () => input(stuckUrl) });
    thumbnails.consider(save(40));
    thumbnails.consider(save(40, B));
    await expect.poll(() => spawned).toBe(1);

    const started = Date.now();
    await thumbnails.shutdown();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(runningChildCount()).toBe(0);
    thumbnails.consider(save(400));
    await thumbnails.idle();
    expect(spawned).toBe(1);
  });
});

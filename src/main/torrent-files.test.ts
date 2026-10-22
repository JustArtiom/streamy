import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcChannel, type TorrentFileOpened } from "../shared/api";
import type { EngineConnection } from "./engine/host";
import { serializeError } from "./logs";
import {
  createFakeWebContents,
  electron,
  resetFakeElectron,
} from "./test/fake-electron";
import {
  findTorrentFiles,
  MAX_TORRENT_FILE_BYTES,
  readTorrentFile,
  receiveTorrentFiles,
} from "./torrent-files";

vi.mock(
  "electron",
  async () => (await import("./test/fake-electron")).electron,
);

const INFO_HASH = "08ada5a7a6183aae1e09d831df6748d566095a10";

describe("findTorrentFiles (command line arguments)", () => {
  it("finds .torrent files and ignores everything else", () => {
    expect(
      findTorrentFiles(
        [
          "/opt/Streamy/streamy",
          "--user-data-dir=/tmp/x.torrent",
          "--no-sandbox",
          "/home/me/Downloads/Movie.TORRENT",
          "/home/me/notes.txt",
          "magnet:?xt=urn:btih:abc&dn=movie.torrent",
          "https://example.com/movie.torrent",
        ],
        { cwd: "/home/me", platform: "linux" },
      ),
    ).toEqual(["/home/me/Downloads/Movie.TORRENT"]);
  });

  it("resolves relative paths and file:// URLs", () => {
    expect(
      findTorrentFiles(
        ["movie.torrent", "file:///home/me/My%20Show.torrent", "file://bad"],
        { cwd: "/home/me/Downloads", platform: "linux" },
      ),
    ).toEqual(["/home/me/Downloads/movie.torrent", "/home/me/My Show.torrent"]);
  });

  it("understands Windows paths", () => {
    expect(
      findTorrentFiles(
        [
          "C:\\Program Files\\Streamy\\Streamy.exe",
          "C:\\Users\\Me\\Downloads\\Big Movie.torrent",
          "relative\\show.torrent",
          "file:///C:/Users/Me/x.torrent",
        ],
        { cwd: "D:\\Work", platform: "win32" },
      ),
    ).toEqual([
      "C:\\Users\\Me\\Downloads\\Big Movie.torrent",
      "D:\\Work\\relative\\show.torrent",
      "C:\\Users\\Me\\x.torrent",
    ]);
  });

  it("opens each file once", () => {
    expect(
      findTorrentFiles(["/a.torrent", "/a.torrent"], {
        cwd: "/",
        platform: "darwin",
      }),
    ).toEqual(["/a.torrent"]);
  });
});

describe("readTorrentFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "streamy-torrent-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a torrent file", async () => {
    const file = join(dir, "a.torrent");
    writeFileSync(file, "d4:infod4:name1:aee");

    expect(Buffer.from(await readTorrentFile(file)).toString()).toBe(
      "d4:infod4:name1:aee",
    );
  });

  it("accepts exactly 10 MB, and refuses more without reading it", async () => {
    const file = join(dir, "big.torrent");
    writeFileSync(file, "");
    truncateSync(file, MAX_TORRENT_FILE_BYTES);
    expect((await readTorrentFile(file)).length).toBe(MAX_TORRENT_FILE_BYTES);

    truncateSync(file, MAX_TORRENT_FILE_BYTES + 1);
    await expect(readTorrentFile(file)).rejects.toThrow(
      '"big.torrent" is too big to be a torrent file (over 10 MB).',
    );
  });

  it.each([
    ["missing.torrent", '"missing.torrent" couldn\'t be found.'],
    ["empty.torrent", '"empty.torrent" is empty.'],
    ["folder.torrent", '"folder.torrent" isn\'t a file.'],
  ])("explains why it can't use %s", async (name, message) => {
    writeFileSync(join(dir, "empty.torrent"), "");
    mkdirSync(join(dir, "folder.torrent"));

    await expect(readTorrentFile(join(dir, name))).rejects.toThrow(message);
  });
});

describe("receiveTorrentFiles", () => {
  let dir: string;
  let server: Server;
  let connection: EngineConnection;
  let answer: (response: ServerResponse) => void;
  let uploads: number[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "streamy-torrent-"));
    uploads = [];
    answer = (response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ torrent: { infoHash: INFO_HASH } }));
    };
    server = createServer((request, response) => {
      let size = 0;
      request.on("data", (chunk: Buffer) => (size += chunk.length));
      request.on("end", () => {
        if (request.url === "/v1/torrents/file") uploads.push(size);
        answer(response);
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    connection = {
      port: (server.address() as AddressInfo).port,
      secret: "c".repeat(64),
    };
  });

  afterEach(async () => {
    resetFakeElectron();
    rmSync(dir, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function torrentFile(name = "movie.torrent", content = "d4:infodee") {
    const file = join(dir, name);
    writeFileSync(file, content);
    return file;
  }

  function setup(whenRunning = () => Promise.resolve(connection)) {
    const contents = createFakeWebContents();
    const showWindow = vi.fn(() => contents as never);
    const lines: string[] = [];
    const log = pino(
      { serializers: { err: serializeError } },
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(chunk.toString());
          done();
        },
      }),
    );
    const files = receiveTorrentFiles({
      showWindow,
      engine: { whenRunning },
      log,
    });
    /** Waits for the next result sent to the UI. */
    const nextResult = () =>
      vi.waitFor(() => {
        const call = contents.send.mock.calls.find(
          ([channel]) => channel === IpcChannel.TorrentFileOpened,
        );
        if (!call) throw new Error("Nothing sent yet");
        return call[1] as TorrentFileOpened;
      });
    return {
      contents,
      showWindow,
      files,
      nextResult,
      logText: () => lines.join(""),
    };
  }

  it("keeps a file opened during startup (macOS) until the app is ready", async () => {
    const { files, showWindow, nextResult } = setup();
    const event = { preventDefault: vi.fn() };

    electron.app.emit("open-file", event, torrentFile());
    expect(event.preventDefault).toHaveBeenCalled();
    expect(showWindow).not.toHaveBeenCalled();

    files.start();
    expect(await nextResult()).toEqual({ status: "ok", infoHash: INFO_HASH });
    expect(uploads).toEqual(["d4:infodee".length]);
  });

  it("opens files from a second launch's arguments (Windows/Linux)", async () => {
    const { files, nextResult } = setup();
    files.start();
    torrentFile("show.torrent", "d4:infod1:xi1eee");

    files.fromArgv(["streamy", "--flag", "show.torrent"], dir);

    expect(await nextResult()).toMatchObject({ status: "ok" });
    expect(uploads).toEqual(["d4:infod1:xi1eee".length]);
  });

  it("waits for the page to load before handing the result over", async () => {
    const { files, contents, nextResult } = setup();
    files.start();
    contents.isLoading.mockReturnValue(true);

    electron.app.emit("open-file", { preventDefault: vi.fn() }, torrentFile());
    await vi.waitFor(() => {
      expect(uploads).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(contents.send).not.toHaveBeenCalled();

    contents.emit("did-finish-load");
    expect(await nextResult()).toMatchObject({ status: "ok" });
  });

  it("passes on the engine's reason for refusing a file", async () => {
    answer = (response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { code: "BAD_REQUEST", message: "That isn't a torrent file." },
        }),
      );
    };
    const { files, nextResult } = setup();
    files.start();

    electron.app.emit("open-file", { preventDefault: vi.fn() }, torrentFile());

    expect(await nextResult()).toEqual({
      status: "error",
      message:
        "\"movie.torrent\" couldn't be opened. That isn't a torrent file.",
    });
  });

  it("says when the engine isn't running", async () => {
    const { files, nextResult } = setup(() =>
      Promise.reject(new Error("failed")),
    );
    files.start();

    electron.app.emit("open-file", { preventDefault: vi.fn() }, torrentFile());

    expect(await nextResult()).toMatchObject({
      status: "error",
      message: expect.stringContaining("isn't running") as unknown,
    });
  });

  it("reports a file it can't read, without bothering the engine", async () => {
    const whenRunning = vi.fn(() => Promise.resolve(connection));
    const { files, nextResult } = setup(whenRunning);
    files.start();

    electron.app.emit(
      "open-file",
      { preventDefault: vi.fn() },
      join(dir, "gone.torrent"),
    );

    expect(await nextResult()).toEqual({
      status: "error",
      message: '"gone.torrent" couldn\'t be found.',
    });
    expect(whenRunning).not.toHaveBeenCalled();
  });

  it("never writes the file's name to the log", async () => {
    const { files, nextResult, logText } = setup();
    files.start();

    electron.app.emit(
      "open-file",
      { preventDefault: vi.fn() },
      join(dir, "Secret Holiday.torrent"),
    );

    expect(await nextResult()).toMatchObject({ status: "error" });
    expect(logText()).toContain('"problem":"missing"');
    expect(logText()).not.toContain("Secret Holiday");
  });

  it("ignores files that aren't torrents", () => {
    const { files, showWindow } = setup();
    files.start();

    electron.app.emit(
      "open-file",
      { preventDefault: vi.fn() },
      torrentFile("notes.txt"),
    );

    expect(showWindow).not.toHaveBeenCalled();
  });

  it("opens the file picked in File → Open Torrent File…", async () => {
    const { files, nextResult, showWindow } = setup();
    files.start();

    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    await files.chooseAndOpen(null);
    expect(showWindow).not.toHaveBeenCalled();

    electron.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: [torrentFile()],
    });
    await files.chooseAndOpen(null);
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [{ name: "Torrent files", extensions: ["torrent"] }],
      }),
    );
    expect(await nextResult()).toMatchObject({ status: "ok" });
  });
});

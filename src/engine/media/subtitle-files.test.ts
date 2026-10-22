import { describe, expect, it } from "vitest";
import type { FileKind, TorrentFile } from "../../shared/engine-api";
import {
  episodeTag,
  subtitleFilesFor,
  toSubtitleTrack,
} from "./subtitle-files";

function files(...paths: [string, FileKind][]): TorrentFile[] {
  return paths.map(([path, kind], index) => ({
    index,
    name: path.split("/").at(-1) ?? path,
    path,
    size: 1000,
    kind,
    progress: 0,
  }));
}

function names(list: TorrentFile[]) {
  return list.map((f) => f.name);
}

describe("subtitleFilesFor", () => {
  it("one video: every text subtitle file belongs to it", () => {
    const all = files(
      ["Sintel/Sintel.mp4", "video"],
      ["Sintel/Sintel.en.srt", "subtitle"],
      ["Sintel/Subs/Spanish.ass", "subtitle"],
      ["Sintel/Sintel.sub", "subtitle"],
      ["Sintel/poster.jpg", "image"],
    );
    expect(names(subtitleFilesFor(all[0] as TorrentFile, all))).toEqual([
      "Sintel.en.srt",
      "Spanish.ass",
    ]);
  });

  it("several videos: by name prefix, episode tag or folder", () => {
    const all = files(
      ["Show/Show.S01E01.mkv", "video"],
      ["Show/Show.S01E02.mkv", "video"],
      ["Show/Show.S01E01.en.srt", "subtitle"],
      ["Show/Show.S01E02.en.srt", "subtitle"],
      ["Show/Subs/Show.S01E02/2_English.srt", "subtitle"],
      ["Show/Subs/Russian.s01e02.srt", "subtitle"],
      ["Show/Subs/Show 1x02 fr.vtt", "subtitle"],
      ["Show/Subs/Show.S01E12.srt", "subtitle"],
    );
    const episode2 = all[1] as TorrentFile;
    expect(names(subtitleFilesFor(episode2, all))).toEqual([
      "Show.S01E02.en.srt",
      "2_English.srt",
      "Russian.s01e02.srt",
      "Show 1x02 fr.vtt",
    ]);
  });

  it("a name prefix needs a separator (Movie vs Movie 2)", () => {
    const all = files(
      ["Movie.mkv", "video"],
      ["Movies.mkv", "video"],
      ["Movie.en.srt", "subtitle"],
      ["Movies.en.srt", "subtitle"],
    );
    expect(names(subtitleFilesFor(all[0] as TorrentFile, all))).toEqual([
      "Movie.en.srt",
    ]);
  });
});

describe("episodeTag", () => {
  it.each([
    ["Show.S01E02.mkv", "1x2"],
    ["show s1e2 720p.mkv", "1x2"],
    ["Show 1x02.srt", "1x2"],
    ["Show.S01.E02.mkv", "1x2"],
    ["Movie.1920x1080.mkv", null],
    ["Movie.2019.mkv", null],
  ])("%s → %s", (name, tag) => {
    expect(episodeTag(name)).toBe(tag);
  });
});

describe("toSubtitleTrack", () => {
  it("makes a file track with the language from the name", () => {
    const [video, subtitle] = files(
      ["Sintel/Sintel.mp4", "video"],
      ["Sintel/Sintel.pt.forced.srt", "subtitle"],
    ) as [TorrentFile, TorrentFile];
    expect(toSubtitleTrack(video, subtitle)).toEqual({
      id: "file:1",
      source: "file",
      codec: "subrip",
      language: "pt",
      title: "Sintel.pt.forced.srt",
      isDefault: false,
      isForced: true,
      isText: true,
    });
  });
});

import { describe, expect, it } from "vitest";
import { contentType, fileExtension, fileKind } from "./file-kind";

describe("fileKind", () => {
  it.each([
    ["Sintel.mp4", "video"],
    ["Movie.2020.1080p.MKV", "video"],
    ["clip.webm", "video"],
    ["old.avi", "video"],
    ["episode.m2ts", "video"],
    ["track01.flac", "audio"],
    ["dub.mka", "audio"],
    ["Sintel.en.srt", "subtitle"],
    ["subs.ASS", "subtitle"],
    ["movie.sup", "subtitle"],
    ["poster.jpg", "image"],
    ["cover.webp", "image"],
    ["readme.txt", "other"],
    ["sample.nfo", "other"],
    ["no-extension", "other"],
    [".hidden", "other"],
  ])("%s is %s", (name, kind) => {
    expect(fileKind(name)).toBe(kind);
  });
});

describe("contentType", () => {
  it.each([
    ["a.mp4", "video/mp4"],
    ["a.webm", "video/webm"],
    ["a.mkv", "video/x-matroska"],
    ["a.avi", "video/x-msvideo"],
    ["a.mov", "video/quicktime"],
    ["a.ts", "video/mp2t"],
    ["a.vtt", "text/vtt"],
    ["a.SRT", "application/x-subrip"],
    ["a.flac", "application/octet-stream"],
    ["a", "application/octet-stream"],
  ])("%s → %s", (name, type) => {
    expect(contentType(name)).toBe(type);
  });
});

describe("fileExtension", () => {
  it("lower-cases and drops the dot", () => {
    expect(fileExtension("Folder/Movie.MKV")).toBe("mkv");
    expect(fileExtension("Movie")).toBe("");
  });
});

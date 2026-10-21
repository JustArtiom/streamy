import { describe, expect, it } from "vitest";
import { formatBytes } from "@/lib/format";

describe("formatBytes", () => {
  it.each([
    [0, "0 bytes"],
    [999, "999 bytes"],
    [1_000, "1 kB"],
    [1_234_567, "1.2 MB"],
    [3_400_000_000, "3.4 GB"],
    [512_000_000_000, "512 GB"],
    [2_000_000_000_000, "2 TB"],
  ])("%d → %s", (bytes, text) => {
    expect(formatBytes(bytes, "en-US")).toBe(text);
  });

  it("uses the user's number format", () => {
    expect(formatBytes(1_234_567, "de-DE")).toBe("1,2 MB");
  });
});

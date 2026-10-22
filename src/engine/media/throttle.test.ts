import { describe, expect, it } from "vitest";
import { throttleAction } from "./throttle";

const base = { held: false, position: 100, aheadSeconds: 240 };

describe("throttleAction", () => {
  it("holds the input back when ffmpeg is more than aheadSeconds ahead", () => {
    expect(throttleAction({ ...base, producedUntil: 341 })).toBe("hold");
    expect(throttleAction({ ...base, producedUntil: 340 })).toBeNull();
  });

  it("keeps holding until the viewer is within aheadSeconds - 60", () => {
    const held = { ...base, held: true };
    expect(throttleAction({ ...held, producedUntil: 341 })).toBeNull();
    expect(throttleAction({ ...held, producedUntil: 290 })).toBeNull();
    expect(throttleAction({ ...held, producedUntil: 279 })).toBe("release");
  });

  it("lets go when the viewer jumped past what's produced", () => {
    expect(throttleAction({ ...base, held: true, producedUntil: 50 })).toBe(
      "release",
    );
  });

  it("uses half of a small aheadSeconds as the margin", () => {
    const small = { position: 0, aheadSeconds: 10 };
    expect(throttleAction({ ...small, held: false, producedUntil: 11 })).toBe(
      "hold",
    );
    expect(
      throttleAction({ ...small, held: true, producedUntil: 6 }),
    ).toBeNull();
    expect(throttleAction({ ...small, held: true, producedUntil: 4 })).toBe(
      "release",
    );
  });

  it("does nothing while flowing and close enough", () => {
    expect(throttleAction({ ...base, producedUntil: 120 })).toBeNull();
  });
});

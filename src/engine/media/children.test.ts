import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  killAllChildren,
  runningChildCount,
  setAcceptingChildren,
  setChildReporter,
  trackChild,
} from "./children";

// Plain Node stands in for ffmpeg: a process that ends, and one that waits.
const node = process.execPath;

afterEach(() => {
  killAllChildren();
  setChildReporter(null);
});

describe("child processes", () => {
  it("reports the start and the end of each one", async () => {
    const events: { pid: number; alive: boolean }[] = [];
    setChildReporter((pid, alive) => events.push({ pid, alive }));

    const child = trackChild(spawn(node, ["-e", ""], { stdio: "ignore" }));
    const pid = child.pid ?? 0;
    expect(events).toEqual([{ pid, alive: true }]);
    expect(runningChildCount()).toBe(1);

    await once(child, "exit");
    expect(events).toEqual([
      { pid, alive: true },
      { pid, alive: false },
    ]);
    expect(runningChildCount()).toBe(0);
  });

  it("reports nothing for a program that doesn't exist", async () => {
    const events: unknown[] = [];
    setChildReporter((pid, alive) => events.push({ pid, alive }));

    const child = trackChild(spawn("/no/such/ffmpeg", [], { stdio: "ignore" }));
    await once(child, "error");

    expect(events).toEqual([]);
    expect(runningChildCount()).toBe(0);
  });

  it("kills whatever still runs (shutdown)", async () => {
    const child = trackChild(
      spawn(node, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" }),
    );
    const exited = once(child, "exit");

    killAllChildren();

    const [, signal] = (await exited) as [number | null, string | null];
    expect(signal).toBe("SIGKILL");
    expect(runningChildCount()).toBe(0);
  });

  it("keeps going when reporting fails (main is gone)", async () => {
    setChildReporter(() => {
      throw new Error("port closed");
    });
    const child = trackChild(spawn(node, ["-e", ""], { stdio: "ignore" }));
    await once(child, "exit");
    expect(runningChildCount()).toBe(0);
  });
});

describe("after shutdown began", () => {
  afterEach(() => {
    setAcceptingChildren(true);
  });

  it("kills new processes as soon as they start", async () => {
    setAcceptingChildren(false);
    const child = trackChild(
      spawn(node, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" }),
    );

    const [, signal] = (await once(child, "exit")) as [
      number | null,
      string | null,
    ];
    expect(signal).toBe("SIGKILL");
  });
});

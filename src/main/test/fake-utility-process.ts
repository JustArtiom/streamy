import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

let nextPid = 1000;

/**
 * Stands in for an Electron UtilityProcess (the engine) in tests. The test
 * plays the engine's part: `reply()` sends a message to main, `exit()` ends
 * the process.
 */
export class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = nextPid++;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Messages main sent to the engine. */
  readonly received: unknown[] = [];
  /** Whether kill() ends the process (a hung process ignores it). */
  exitsWhenKilled = true;

  readonly postMessage = vi.fn((message: unknown) => {
    if (this.pid === undefined) throw new Error("Process is gone");
    this.received.push(message);
  });

  readonly kill = vi.fn(() => {
    if (this.exitsWhenKilled) {
      queueMicrotask(() => {
        this.exit(15);
      });
    }
    return true;
  });

  readonly modulePath: string;
  readonly args: string[];
  readonly options: Record<string, unknown>;

  constructor(
    modulePath: string,
    args: string[],
    options: Record<string, unknown>,
  ) {
    super();
    this.modulePath = modulePath;
    this.args = args;
    this.options = options;
  }

  /** The engine sends `message` to main. */
  reply(message: unknown): void {
    this.emit("message", message);
  }

  /** The process ends (crash, kill or normal exit). */
  exit(code: number): void {
    if (this.pid === undefined) return;
    this.pid = undefined;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code);
  }

  /** Messages of one type that main sent. */
  sent(type: string): Record<string, unknown>[] {
    return this.received.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === type,
    );
  }
}

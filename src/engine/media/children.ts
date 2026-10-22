import type { ChildProcess } from "node:child_process";

/*
 * Every ffmpeg/ffprobe the engine spawns is passed to trackChild(), so:
 * - main hears about each one (`child { pid, alive }`). If the engine
 *   crashes, main kills the ones still alive: on macOS and Linux they would
 *   otherwise keep running, orphaned.
 * - shutdown can kill whatever is still running.
 */

type ChildReporter = (pid: number, alive: boolean) => void;

let reporter: ChildReporter = () => undefined;
const running = new Set<ChildProcess>();
/** false once shutdown began: anything spawned after that is killed at once. */
let accepting = true;

/** Where spawns and exits are reported (the engine posts them to main). */
export function setChildReporter(report: ChildReporter | null): void {
  reporter = report ?? (() => undefined);
}

function report(pid: number, alive: boolean): void {
  try {
    reporter(pid, alive);
  } catch {
    // Main is gone (the port closed): nothing to tell anymore.
  }
}

/** Call right after spawn(): reports it and follows it until it exits. */
export function trackChild<T extends ChildProcess>(child: T): T {
  const { pid } = child;
  // No pid = it never started (e.g. missing program): "error" follows.
  if (pid === undefined) return child;

  running.add(child);
  report(pid, true);
  child.once("exit", () => {
    running.delete(child);
    report(pid, false);
  });
  // E.g. the encoder detection moving on to its next test after shutdown
  // killed the previous one.
  if (!accepting) child.kill("SIGKILL");
  return child;
}

/** How many tracked processes are running (tests). */
export function runningChildCount(): number {
  return running.size;
}

/**
 * Shutdown: from now on, new processes are killed as soon as they start
 * (true again when an engine starts).
 */
export function setAcceptingChildren(value: boolean): void {
  accepting = value;
}

/**
 * Shutdown's last step: SIGKILL whatever still runs (a stuck ffprobe, the
 * encoder test). Playback sessions are stopped gently before this.
 */
export function killAllChildren(): void {
  for (const child of running) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

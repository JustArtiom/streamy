import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Looking at the processes the tests started (macOS and Linux: `ps`, `lsof`).
//
// Every process of one launch of Streamy mentions that test's workspace
// folder on its command line: Electron and its helpers get
// --user-data-dir=<workspace>/profile, and ffmpeg/ffprobe are started from
// <workspace>/bin (see workspace.ts). So "nothing left behind" is simply
// "no process mentions the workspace any more".

const run = promisify(execFile);

export type ProcessInfo = { pid: number; args: string };

/** Running processes whose command line contains `text`. */
export async function processesMentioning(
  text: string,
): Promise<ProcessInfo[]> {
  // -ww: whole command lines, however long.
  const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,args="], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const found: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match?.[1] || !match[2]?.includes(text)) continue;
    const pid = Number(match[1]);
    if (pid !== process.pid) found.push({ pid, args: match[2] });
  }
  return found;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, it just isn't ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGKILL, ignoring processes that are already gone. */
export function killHard(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * UDP sockets a process has open. The engine in test mode should have none:
 * DHT, UDP trackers, LSD and UPnP/NAT-PMP all use UDP.
 */
export async function udpSockets(pid: number): Promise<string[]> {
  try {
    const { stdout } = await run("lsof", [
      "-nP",
      "-a",
      "-p",
      String(pid),
      "-iUDP",
    ]);
    // The first line is lsof's header.
    return stdout.split("\n").slice(1).filter(Boolean);
  } catch (error) {
    // lsof exits with 1 when it found nothing.
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

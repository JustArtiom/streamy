import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Total size in bytes of the files under `dir` (0 if it doesn't exist).
 * Files can disappear while we walk (ffmpeg renames its temp files, sessions
 * get deleted): those are skipped.
 */
export async function dirSize(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isGone(err)) return 0;
    throw err;
  }

  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(path);
    } else if (entry.isFile()) {
      try {
        total += (await lstat(path)).size;
      } catch (err) {
        if (!isGone(err)) throw err;
      }
    }
  }
  return total;
}

function isGone(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

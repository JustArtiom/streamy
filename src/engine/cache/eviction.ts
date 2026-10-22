// Keeping the video folder under its size limit (PLAN §4.7), and freeing
// space when the disk is almost full: which stored torrents to delete.
// Pure, so it's easy to test; the caller measures the folder, asks the
// torrent client which torrents are active, and deletes.

export interface EvictionCandidate {
  infoHash: string;
  /** Space it takes on disk (see measureTorrents). */
  bytes: number;
  /** When it was last used (ms since 1970). */
  lastUsedAt: number;
  /** Running in the torrent client (being watched or idling): never deleted. */
  active: boolean;
}

export interface EvictionInput {
  /** One entry per torrent in the folder. */
  torrents: readonly EvictionCandidate[];
  /** null = no limit. */
  limitBytes: number | null;
  /**
   * Also delete stored torrents (least recently used first) until at least
   * this much is freed, whatever the limit: the disk is almost full.
   * Default 0.
   */
  mustFreeBytes?: number;
}

export interface EvictionPlan {
  /** Stored torrents to delete, in this order: least recently used first. */
  evict: string[];
  /** Space the torrents use now. */
  usedBytes: number;
  /** Space used once `evict` is deleted. */
  usedBytesAfter: number;
  /**
   * Still over the limit with every stored torrent deleted: only active ones
   * are left. The caller should stop background downloads (keep playing)
   * and log it.
   */
  stillOverLimit: boolean;
}

function assertBytes(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${what} must be a finite number ≥ 0, got ${value}`);
  }
}

/**
 * Over the limit (strictly more than `limitBytes`), or short of
 * `mustFreeBytes` → delete stored torrents, least recently used first,
 * until it fits and enough is freed. Ties go to the bigger torrent first
 * (fewer deletions), then by info hash, so the plan is always the same for
 * the same input.
 */
export function planEviction({
  torrents,
  limitBytes,
  mustFreeBytes = 0,
}: EvictionInput): EvictionPlan {
  if (limitBytes !== null) assertBytes(limitBytes, "limitBytes");
  assertBytes(mustFreeBytes, "mustFreeBytes");
  for (const torrent of torrents) {
    assertBytes(torrent.bytes, `bytes of ${torrent.infoHash}`);
    if (!Number.isFinite(torrent.lastUsedAt)) {
      throw new RangeError(`lastUsedAt of ${torrent.infoHash} must be finite`);
    }
  }

  const usedBytes = torrents.reduce(
    (total, torrent) => total + torrent.bytes,
    0,
  );
  const fits = (bytes: number) => limitBytes === null || bytes <= limitBytes;

  const stored = torrents
    .filter((torrent) => !torrent.active)
    .sort(
      (a, b) =>
        a.lastUsedAt - b.lastUsedAt ||
        b.bytes - a.bytes ||
        a.infoHash.localeCompare(b.infoHash),
    );

  const evict: string[] = [];
  let usedBytesAfter = usedBytes;
  for (const torrent of stored) {
    const freed = usedBytes - usedBytesAfter;
    if (fits(usedBytesAfter) && freed >= mustFreeBytes) break;
    evict.push(torrent.infoHash);
    usedBytesAfter -= torrent.bytes;
  }
  return {
    evict,
    usedBytes,
    usedBytesAfter,
    stillOverLimit: !fits(usedBytesAfter),
  };
}

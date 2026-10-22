import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { TorrentDetail } from "../../../shared/engine-api";
import {
  api,
  ApiRequestError,
  isApiError,
  isEngineUnavailable,
} from "@/lib/api";
import { noteTorrentAdded } from "@/lib/ip-notice";
import { shouldRetry } from "@/lib/query-client";

/**
 * Opening a torrent again (after a 404) failed. Kept apart from other
 * errors: it was already retried, so the page says so instead of polling.
 */
export class ReopenFailedError extends ApiRequestError {
  constructor(cause: ApiRequestError) {
    super(cause.status, cause.code, cause.message, cause.issues);
    this.name = "ReopenFailedError";
  }
}

/**
 * Torrents removed in this window. The page that removed one must not open
 * it again by itself (e.g. with a poll that was already on its way). Any
 * page opened afterwards, or adding it, takes it off this list.
 */
const removedHere = new Set<string>();

/**
 * Asks for the torrent, and opens it again if it isn't active anymore (it
 * stops when unused for a while, and the engine forgets active torrents
 * when it restarts). A torrent in the library opens from its saved
 * metadata, so this is instant. One attempt per fetch: if it fails, the
 * error says so (ReopenFailedError).
 */
async function getOrReopen(
  infoHash: string,
  signal: AbortSignal,
): Promise<TorrentDetail> {
  try {
    return await api.getTorrent(infoHash, signal);
  } catch (error) {
    if (!isApiError(error, 404) || removedHere.has(infoHash)) throw error;
  }
  try {
    return await api.addMagnet(infoHash, signal);
  } catch (error) {
    // A stopped engine (or leaving the page) isn't this torrent's fault:
    // those keep their own handling (retry once it's back, or nothing).
    if (error instanceof ApiRequestError && !isEngineUnavailable(error)) {
      throw new ReopenFailedError(error);
    }
    throw error;
  }
}

/**
 * A re-open answered 503 by a running engine: it's busy, e.g. still deleting
 * the videos after Settings → "Clear now". Worth a few more tries (1, 2, 4
 * and 8 s apart: React Query's backoff) before saying it failed.
 */
const REOPEN_RETRIES_WHEN_BUSY = 4;

export const torrentQuery = (infoHash: string) =>
  queryOptions({
    queryKey: ["torrents", infoHash],
    queryFn: ({ signal }) => getOrReopen(infoHash, signal),
    // Polling also tells the engine the torrent is still in use, so it must
    // go on while the window is hidden or minimized: people do that on
    // purpose to let it download. (React Query pauses it by default.)
    refetchIntervalInBackground: true,
    // Faster while waiting for metadata or checking the data on disk, so
    // the file list and the Play buttons show up quickly.
    refetchInterval: (query) => {
      const { data, error, status } = query.state;
      // Already tried to open it again: show why, don't keep trying.
      if (error instanceof ReopenFailedError) return false;
      // Removed here: it won't come back by itself.
      if (isApiError(error, 404)) return false;
      // Failed without any data yet: stop, or every attempt would flip the
      // page between "Loading…" and the error. "Try again" and window focus
      // still refetch.
      if (status === "error" && data === undefined) return false;
      return data?.status === "fetching_metadata" || data?.status === "checking"
        ? 1000
        : 5000;
    },
    retry: (failureCount, error) => {
      if (error instanceof ReopenFailedError) {
        return error.status === 503 && failureCount < REOPEN_RETRIES_WHEN_BUSY;
      }
      return shouldRetry(failureCount, error);
    },
  });

/**
 * One torrent, kept fresh by polling while it's on screen. Re-opens it
 * when it isn't active anymore.
 */
export function useTorrent(infoHash: string) {
  // A page showing it was opened on purpose (Recent, Continue watching,
  // Back…), so it may open it again even if it was removed before.
  useEffect(() => {
    removedHere.delete(infoHash);
  }, [infoHash]);
  return useQuery(torrentQuery(infoHash));
}

export type AddTorrentInput =
  { kind: "magnet"; magnet: string } | { kind: "file"; file: File };

/** Adds a torrent (a magnet, an info hash or a .torrent file). */
export function useAddTorrent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddTorrentInput) =>
      input.kind === "magnet"
        ? api.addMagnet(input.magnet.trim())
        : api.addTorrentFile(input.file),
    onSuccess: (torrent) => {
      torrentAdded(queryClient, torrent);
    },
  });
}

/**
 * Everything that follows adding a torrent, wherever it was added (also by
 * the main process, for a .torrent opened from the OS).
 */
export function torrentAdded(
  queryClient: QueryClient,
  torrent: TorrentDetail | { infoHash: string },
): void {
  removedHere.delete(torrent.infoHash);
  if ("files" in torrent) {
    queryClient.setQueryData(torrentQuery(torrent.infoHash).queryKey, torrent);
  }
  void queryClient.invalidateQueries({ queryKey: ["library"] });
  noteTorrentAdded();
}

export type RemoveTorrentInput = {
  infoHash: string;
  /** Also remove it from the library (Recent, Continue watching). */
  forget: boolean;
};

/** Stops a torrent and deletes its data; `forget` also drops its history. */
export function useRemoveTorrent() {
  const queryClient = useQueryClient();

  return useMutation({
    // Before the request: no poll may open it again from now on.
    onMutate: async ({ infoHash }) => {
      removedHere.add(infoHash);
      await queryClient.cancelQueries({ queryKey: ["torrents", infoHash] });
    },
    mutationFn: ({ infoHash, forget }: RemoveTorrentInput) =>
      api.removeTorrent(infoHash, { forget }),
    onError: (_error, { infoHash }) => {
      removedHere.delete(infoHash);
    },
    onSuccess: (_data, { infoHash }) => {
      torrentRemoved(queryClient, infoHash);
    },
  });
}

/** Forgets cached data about a torrent that isn't there anymore. */
export function torrentRemoved(
  queryClient: QueryClient,
  infoHash: string,
): void {
  removedHere.add(infoHash);
  void queryClient.cancelQueries({ queryKey: ["torrents", infoHash] });
  queryClient.removeQueries({ queryKey: ["torrents", infoHash] });
  queryClient.removeQueries({ queryKey: ["media", infoHash] });
  void queryClient.invalidateQueries({ queryKey: ["library"] });
}

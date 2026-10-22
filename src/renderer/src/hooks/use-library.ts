import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { torrentRemoved } from "@/hooks/use-torrents";
import { api } from "@/lib/api";

// What Streamy remembers between launches (the engine's library.db):
// Continue watching, Recent, and saved positions.

export const libraryQuery = () =>
  queryOptions({
    queryKey: ["library"],
    queryFn: ({ signal }) => api.getLibrary(signal),
    // Cheap (a local database). Keeps "active" in Recent roughly current.
    refetchInterval: 15_000,
  });

export function useLibrary() {
  return useQuery(libraryQuery());
}

/**
 * The engine's picture of a file ("/v1/…/thumbnail"), or null while there
 * isn't one. Only files in Continue watching get one, and the library says
 * when it exists, so nothing asks for a picture that isn't there.
 */
export function useThumbnailPath(
  infoHash: string,
  fileIndex: number,
): string | null {
  const { data } = useQuery({
    ...libraryQuery(),
    // The player and its resume question don't need it kept fresh.
    refetchInterval: false,
  });
  const item = data?.continueWatching.find(
    (entry) => entry.infoHash === infoHash && entry.fileIndex === fileIndex,
  );
  return item?.thumbnailUrl ?? null;
}

/**
 * One torrent's library entry and saved positions; data is null when the
 * library doesn't know it. Under ["library", …] so every library change
 * refreshes it too.
 */
export const libraryTorrentQuery = (infoHash: string) =>
  queryOptions({
    queryKey: ["library", infoHash],
    queryFn: ({ signal }) => api.getLibraryTorrent(infoHash, signal),
  });

export function useLibraryTorrent(infoHash: string) {
  return useQuery(libraryTorrentQuery(infoHash));
}

/** Removes a file from Continue watching (forgets its position). */
export function useRemoveProgress() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      infoHash,
      fileIndex,
    }: {
      infoHash: string;
      fileIndex: number;
    }) => api.removeProgress(infoHash, fileIndex),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
}

/**
 * Removes a torrent from Streamy: its history, positions and downloaded
 * data (it also stops it).
 */
export function useForgetTorrent() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (infoHash: string) => api.forgetTorrent(infoHash),
    onSuccess: (_data, infoHash) => {
      torrentRemoved(queryClient, infoHash);
    },
  });
}

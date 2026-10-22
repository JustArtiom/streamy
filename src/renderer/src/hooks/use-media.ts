import {
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { torrentQuery } from "@/hooks/use-torrents";
import { api, isApiError, isEngineUnavailable } from "@/lib/api";

/**
 * Makes sure the torrent is open in the engine: it stops when unused for a
 * while, and the engine forgets open torrents when it restarts. The torrent
 * query opens it again (from the library's saved metadata) when it's gone,
 * and shares a request that's already on its way.
 */
export function ensureTorrentOpen(
  queryClient: QueryClient,
  infoHash: string,
): Promise<unknown> {
  const { queryKey, queryFn, retry } = torrentQuery(infoHash);
  return queryClient.query({ queryKey, queryFn, retry, staleTime: 0 });
}

export const mediaQuery = (
  queryClient: QueryClient,
  infoHash: string,
  fileIndex: number,
) =>
  queryOptions({
    queryKey: ["media", infoHash, fileIndex],
    queryFn: async ({ signal }) => {
      try {
        return await api.getMedia(infoHash, fileIndex, signal);
      } catch (error) {
        // 404 = the torrent isn't open (anymore): open it, then ask again.
        if (!isApiError(error, 404)) throw error;
        await ensureTorrentOpen(queryClient, infoHash);
        return api.getMedia(infoHash, fileIndex, signal);
      }
    },
    // ffprobe runs once in the engine and the answer never changes.
    staleTime: Infinity,
    // 409 = the torrent has no metadata yet: keep asking every second. A
    // stopped engine gets a few tries (they wait until it's back), network
    // trouble a couple. Anything else is an answer: a 503 already took the
    // engine up to two minutes (ffprobe timeout) or means ffmpeg isn't
    // working, so asking again right away won't help.
    retry: (failureCount, error) => {
      if (isApiError(error, 409)) return true;
      if (isEngineUnavailable(error)) return failureCount < 3;
      return isApiError(error, 0) && failureCount < 2;
    },
    retryDelay: (_attempt, error) => (isApiError(error, 409) ? 1000 : 2000),
  });

/** What ffprobe says about a video file (codecs, tracks, duration). */
export function useMediaInfo(infoHash: string, fileIndex: number) {
  const queryClient = useQueryClient();
  return useQuery(mediaQuery(queryClient, infoHash, fileIndex));
}

/** Cues of a subtitle file in the torrent; null fileIndex = nothing to load. */
export function useFileSubtitles(infoHash: string, fileIndex: number | null) {
  return useQuery({
    queryKey: ["file-subtitles", infoHash, fileIndex],
    queryFn: ({ signal }) =>
      fileIndex === null
        ? []
        : api.getFileSubtitles(infoHash, fileIndex, signal),
    enabled: fileIndex !== null,
    staleTime: Infinity,
  });
}

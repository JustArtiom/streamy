import { createElement, useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { type AddTorrentInput, useAddTorrent } from "@/hooks/use-torrents";
import { ApiRequestError, errorMessage, isForPeople } from "@/lib/api";
import { type TorrentPageState, torrentPath } from "@/lib/routes";
import { toast } from "@/lib/toast";

/** The Sintel open movie (Blender Foundation): legal, and it has a web seed. */
export const SINTEL_MAGNET =
  "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";

/**
 * Why adding failed, for people. A validation failure names the field
 * ("body.magnet"); its own message says more than "Some fields are invalid".
 */
export function describeAddError(error: unknown): string {
  if (error instanceof ApiRequestError && error.issues.length > 0) {
    const issue =
      error.issues.find((item) => /magnet|body/.test(item.path)) ??
      error.issues[0];
    if (issue && isForPeople(issue.message)) return issue.message;
  }
  return errorMessage(error);
}

/**
 * The history entry on screen right now. Every useAddAndOpen keeps it
 * current, and the layout's (drop zone, incoming links) are always mounted,
 * so it stays right even after the page that started an add has gone.
 */
let currentLocationKey: string | null = null;

/**
 * Adds a torrent and opens its page. `justAdded` lets that page go straight
 * to the player when there's only one video.
 *
 * An add can take a while (it waits while the engine starts). If the user
 * has gone somewhere else meanwhile (maybe they're watching something), it
 * doesn't pull them away: a toast offers to open it instead.
 */
export function useAddAndOpen() {
  const navigate = useNavigate();
  const location = useLocation();
  const mutation = useAddTorrent();

  useEffect(() => {
    currentLocationKey = location.key;
  }, [location.key]);

  /** Resolves to null when it worked, else to why it didn't. */
  const addAndOpen = async (input: AddTorrentInput): Promise<string | null> => {
    const startedAt = location.key;
    try {
      const torrent = await mutation.mutateAsync(input);
      const open = () => {
        const state: TorrentPageState = { justAdded: true };
        void navigate(torrentPath(torrent.infoHash), { state });
      };
      if (currentLocationKey === null || currentLocationKey === startedAt) {
        open();
      } else {
        const name = torrent.name
          ? createElement("bdi", null, torrent.name)
          : "the torrent";
        toast.success(createElement("span", null, "Added ", name), {
          action: { label: "Open", onClick: open },
        });
      }
      return null;
    } catch (error) {
      return describeAddError(error);
    }
  };

  return {
    addAndOpen,
    isPending: mutation.isPending,
    /** What's being added right now (to put a spinner on the right button). */
    pendingInput: mutation.isPending ? mutation.variables : undefined,
  };
}

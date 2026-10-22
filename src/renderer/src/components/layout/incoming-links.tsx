import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useEffectEvent } from "react";
import { useNavigate } from "react-router";
import { useAddAndOpen } from "@/hooks/use-add-and-open";
import { torrentAdded } from "@/hooks/use-torrents";
import { handleIncomingLinks, type IncomingLink } from "@/lib/incoming-links";
import { peopleText } from "@/lib/people-text";
import { type TorrentPageState, torrentPath } from "@/lib/routes";
import { toast } from "@/lib/toast";

/**
 * Opens magnet links and .torrent files that come from outside Streamy (a
 * browser, Finder, "Open with"): straight to the torrent's page. Renders
 * nothing. Lives in the layout, so it works whatever page is showing.
 */
export function IncomingLinks() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { addAndOpen } = useAddAndOpen();

  const open = useEffectEvent((incoming: IncomingLink) => {
    if (incoming.kind === "magnet") {
      // If the engine is still starting (Streamy was launched by this
      // link), the request waits for it.
      void addAndOpen({ kind: "magnet", magnet: incoming.link }).then(
        (problem) => {
          if (problem) {
            toast.error("Couldn't open the magnet link", {
              description: problem,
            });
          }
        },
      );
      return;
    }

    const { result } = incoming;
    if (result.status === "error") {
      toast.error("Couldn't open the .torrent file", {
        // From the main process: a sentence, but never trusted blindly.
        description: peopleText(
          result.message,
          "It may be damaged, or not a .torrent file.",
        ),
      });
      return;
    }
    // The main process already added it to the engine.
    torrentAdded(queryClient, { infoHash: result.infoHash });
    const state: TorrentPageState = { justAdded: true };
    void navigate(torrentPath(result.infoHash), { state });
  });

  useEffect(
    () =>
      handleIncomingLinks((incoming) => {
        open(incoming);
      }),
    [],
  );

  return null;
}

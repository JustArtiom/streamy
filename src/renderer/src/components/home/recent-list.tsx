import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import type { LibraryTorrent } from "../../../../shared/engine-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useForgetTorrent } from "@/hooks/use-library";
import { useNow } from "@/hooks/use-now";
import { errorMessage } from "@/lib/api";
import { formatBytes, formatRelativeTime } from "@/lib/format";
import { torrentPath } from "@/lib/routes";
import { toast } from "@/lib/toast";

/** Torrents opened before, newest first. One click opens one again. */
export function RecentList({ torrents }: { torrents: LibraryTorrent[] }) {
  const forget = useForgetTorrent();
  const [removing, setRemoving] = useState<LibraryTorrent | null>(null);
  // "5 minutes ago" moves on by itself.
  const now = useNow(60_000);

  if (torrents.length === 0) return null;

  const close = () => {
    forget.reset();
    setRemoving(null);
  };

  return (
    <section aria-labelledby="recent" className="flex flex-col gap-3">
      <h2 id="recent" className="text-sm font-medium">
        Recent
      </h2>
      <Card padding="none" className="overflow-hidden">
        <ul className="divide-y divide-border">
          {torrents.map((torrent) => {
            const opened = formatRelativeTime(torrent.lastOpenedAt, now);
            return (
              <li
                key={torrent.infoHash}
                className="relative flex items-center gap-3 p-3 pl-4 transition-colors hover:bg-muted"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {/* Stretched over the row: the whole row opens it. */}
                  {/* dir="auto": a right-to-left name is cut at its own end. */}
                  <Link
                    to={torrentPath(torrent.infoHash)}
                    title={torrent.name}
                    dir="auto"
                    className="truncate text-start text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                  >
                    {torrent.name}
                  </Link>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {[
                      torrent.size !== null && formatBytes(torrent.size),
                      opened && `Opened ${opened}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                {torrent.active && (
                  <Badge
                    tone="success"
                    dot
                    title="Connected to peers: downloading and sharing"
                  >
                    Active
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="relative z-10"
                  aria-label={`Remove ${torrent.name} from Streamy`}
                  title="Remove from Streamy"
                  onClick={() => {
                    forget.reset();
                    setRemoving(torrent);
                  }}
                >
                  <Trash2 />
                </Button>
              </li>
            );
          })}
        </ul>
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title={
          <>
            Remove {removing ? <bdi>{removing.name}</bdi> : "it"} from Streamy?
          </>
        }
        description="It leaves Recent and Continue watching, and its downloaded video is deleted."
        confirmLabel="Remove"
        busy={forget.isPending}
        error={forget.error ? errorMessage(forget.error) : null}
        onClose={close}
        onConfirm={() => {
          if (!removing) return;
          const { infoHash, name } = removing;
          forget.mutate(infoHash, {
            onSuccess: () => {
              toast.success(
                <>
                  Removed <bdi>{name}</bdi> from Streamy
                </>,
              );
              close();
            },
          });
        }}
      />
    </section>
  );
}

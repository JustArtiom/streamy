import { Ellipsis, ListVideo, X } from "lucide-react";
import { useId } from "react";
import { Link, useNavigate } from "react-router";
import type { ContinueWatchingItem } from "../../../../shared/engine-api";
import { Thumbnail } from "@/components/home/thumbnail";
import { ProgressBar } from "@/components/torrent/progress-bar";
import { Menu, MenuItem } from "@/components/ui/menu";
import { useRemoveProgress } from "@/hooks/use-library";
import { errorMessage } from "@/lib/api";
import { readableName } from "@/lib/file-names";
import { formatTimeLeft } from "@/lib/format";
import { torrentPath, type WatchPageState, watchPath } from "@/lib/routes";
import { toast } from "@/lib/toast";

/** Videos started but not finished, newest first. Hidden when empty. */
export function ContinueWatching({ items }: { items: ContinueWatchingItem[] }) {
  if (items.length === 0) return null;

  return (
    <section
      aria-labelledby="continue-watching"
      className="flex flex-col gap-3"
    >
      <h2 id="continue-watching" className="text-sm font-medium">
        Continue watching
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4">
        {items.map((item) => (
          <ContinueCard
            key={`${item.infoHash}:${item.fileIndex}`}
            item={item}
          />
        ))}
      </ul>
    </section>
  );
}

function ContinueCard({ item }: { item: ContinueWatchingItem }) {
  const navigate = useNavigate();
  const remove = useRemoveProgress();
  const detailsId = useId();
  const title = readableName(item.fileName);
  // The torrent's name only when it says something the file name doesn't.
  const subtitle =
    item.torrentName && readableName(item.torrentName) !== title
      ? item.torrentName
      : null;
  const fraction =
    item.duration && item.duration > 0 ? item.position / item.duration : 0;

  return (
    // Not overflow-hidden: the ⋯ menu opens past the card's edge.
    <li className="group relative flex flex-col rounded-lg border border-border bg-background transition-colors hover:bg-muted">
      {/* Only the picture is clipped, to the card's rounded top. */}
      <div className="overflow-hidden rounded-t-[calc(var(--radius-lg)-1px)]">
        <Thumbnail url={item.thumbnailUrl} className="aspect-video" />
        {/* How far in: a line between the picture and the text. */}
        <ProgressBar
          value={fraction}
          tone="neutral"
          className="h-[3px] rounded-none bg-border [&>div]:rounded-none"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5 p-3 pr-10">
        {/* The ::after stretches the link over the whole card, so the card
            is one big click target without nesting the menu button. */}
        <Link
          to={watchPath(item.infoHash, item.fileIndex)}
          // Resuming is what the card offers: the player doesn't ask again.
          state={{ start: "resume" } satisfies WatchPageState}
          title={item.fileName}
          aria-describedby={detailsId}
          // A right-to-left name is cut at its own end.
          dir="auto"
          className="truncate text-start text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
        >
          {title}
        </Link>
        <span id={detailsId} className="flex min-w-0 flex-col gap-0.5">
          {subtitle && (
            <span
              className="truncate text-start text-xs text-muted-foreground"
              title={subtitle}
              dir="auto"
            >
              {subtitle}
            </span>
          )}
          {item.duration !== null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatTimeLeft(item.duration - item.position)}
            </span>
          )}
        </span>
      </div>
      <Menu
        label={`More for ${title}`}
        className="absolute right-2 bottom-2.5 z-10"
        triggerClassName="size-7 text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent [&_svg]:size-4"
        trigger={<Ellipsis aria-hidden />}
      >
        <MenuItem
          onClick={() => {
            void navigate(torrentPath(item.infoHash));
          }}
        >
          <ListVideo aria-hidden />
          Show all files
        </MenuItem>
        <MenuItem
          tone="danger"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate(
              { infoHash: item.infoHash, fileIndex: item.fileIndex },
              {
                onError: (error) => {
                  toast.error("Couldn't remove it", {
                    description: errorMessage(error),
                  });
                },
              },
            );
          }}
        >
          <X aria-hidden />
          Remove from Continue watching
        </MenuItem>
      </Menu>
    </li>
  );
}

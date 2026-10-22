import {
  Captions,
  Check,
  File,
  Film,
  type LucideIcon,
  Play,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { FileProgress, TorrentFile } from "../../../../shared/engine-api";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button-variants";
import { Card } from "@/components/ui/card";
import { formatBytes, formatPercent, formatTime } from "@/lib/format";
import { naturalSortBy } from "@/lib/natural-sort";
import { resumePosition } from "@/lib/resume";
import { type WatchPageState, watchPath } from "@/lib/routes";

/**
 * The files, grouped: videos to play, then subtitles, then everything else.
 * Each group in natural order ("Episode 2" before "Episode 10").
 */
export function FileList({
  infoHash,
  torrentName,
  files,
  progress = [],
}: {
  infoHash: string;
  torrentName: string | null;
  files: TorrentFile[];
  /** Saved positions (from the library), for "Resume at 34:12". */
  progress?: FileProgress[];
}) {
  const sorted = naturalSortBy(files, (file) => file.path);
  const videos = sorted.filter((file) => file.kind === "video");
  const subtitles = sorted.filter((file) => file.kind === "subtitle");
  const other = sorted.filter(
    (file) => file.kind !== "video" && file.kind !== "subtitle",
  );

  if (files.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This torrent has no files.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {videos.length === 0 && (
        <p className="text-sm text-muted-foreground">
          There's no video in this torrent, so there's nothing to play.
        </p>
      )}
      <FileGroup
        title="Videos"
        icon={Film}
        files={videos}
        torrentName={torrentName}
      >
        {(file) => (
          <PlayButton
            infoHash={infoHash}
            file={file}
            progress={progress.find((item) => item.fileIndex === file.index)}
          />
        )}
      </FileGroup>
      <FileGroup
        title="Subtitles"
        icon={Captions}
        files={subtitles}
        torrentName={torrentName}
      />
      <FileGroup
        title="Other files"
        icon={File}
        files={other}
        torrentName={torrentName}
      />
    </div>
  );
}

/** Play, or "Resume at 34:12" when there's a saved position. */
function PlayButton({
  infoHash,
  file,
  progress,
}: {
  infoHash: string;
  file: TorrentFile;
  progress: FileProgress | undefined;
}) {
  const resumeAt = resumePosition(progress);
  return (
    <div className="flex shrink-0 items-center gap-2">
      {progress?.watched && (
        <Badge tone="success">
          <Check className="size-3" aria-hidden />
          Watched
        </Badge>
      )}
      <Link
        to={watchPath(infoHash, file.index)}
        // "Resume at 34:12" is already the choice: the player doesn't ask.
        state={
          resumeAt === null
            ? undefined
            : ({ start: "resume" } satisfies WatchPageState)
        }
        aria-label={
          resumeAt === null
            ? `Play ${file.name}`
            : `Resume ${file.name} at ${formatTime(resumeAt)}`
        }
        className={buttonVariants({
          size: "sm",
          variant:
            resumeAt === null && progress?.watched ? "outline" : "primary",
        })}
      >
        <Play className="fill-current" aria-hidden />
        {resumeAt === null ? "Play" : `Resume at ${formatTime(resumeAt)}`}
      </Link>
    </div>
  );
}

/**
 * The folder a file sits in, without the torrent's own top folder (every
 * file has it, so it's only noise): "Sintel/Subs/en.srt" → "Subs".
 */
function folderOf(file: TorrentFile, torrentName: string | null) {
  const parts = file.path.split("/").slice(0, -1);
  if (parts[0] === torrentName) parts.shift();
  return parts.join("/");
}

function FileGroup({
  title,
  icon: Icon,
  files,
  torrentName,
  children,
}: {
  title: string;
  icon: LucideIcon;
  files: TorrentFile[];
  torrentName: string | null;
  /** Extra content at the end of each row (the Play button). */
  children?: (file: TorrentFile) => ReactNode;
}) {
  if (files.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        {title}
        <span className="text-muted-foreground tabular-nums">
          {files.length}
        </span>
      </h2>
      <Card padding="none" className="divide-y divide-border">
        {files.map((file) => {
          const folder = folderOf(file, torrentName);
          return (
            <div key={file.index} className="flex items-center gap-3 p-3">
              <Icon
                className="ml-1 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {/* dir="auto": a right-to-left name is cut at its own end. */}
                <span
                  className="truncate text-start text-sm font-medium"
                  title={file.path}
                  dir="auto"
                >
                  {file.name}
                </span>
                <span className="flex min-w-0 gap-2 text-xs text-muted-foreground tabular-nums">
                  <span className="shrink-0">
                    {formatBytes(file.size)}
                    {file.progress > 0 && file.progress < 1 && (
                      <> · {formatPercent(file.progress)} downloaded</>
                    )}
                    {file.progress >= 1 && <> · Downloaded</>}
                  </span>
                  {folder && (
                    <span
                      className="min-w-0 truncate text-start"
                      title={folder}
                      dir="auto"
                    >
                      {folder}
                    </span>
                  )}
                </span>
              </div>
              {children?.(file)}
            </div>
          );
        })}
      </Card>
    </section>
  );
}

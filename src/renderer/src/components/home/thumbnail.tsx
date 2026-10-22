import { Film } from "lucide-react";
import { useState } from "react";
import { engineUrl } from "@/lib/api";
import { cn } from "@/lib/cn";

/**
 * A video frame from the engine ("/v1/…/thumbnail"), or a plain placeholder
 * when there's none yet or it can't load.
 */
export function Thumbnail({
  url,
  className,
}: {
  /** As the API returns it (starts with "/v1/"), or null. */
  url: string | null;
  className?: string;
}) {
  // Which URL failed: a new URL gets a new try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url !== null && failedUrl !== url;

  return (
    <div
      className={cn(
        "relative flex items-center justify-center overflow-hidden bg-linear-to-br from-accent to-muted text-muted-foreground",
        className,
      )}
    >
      {showImage ? (
        <img
          src={engineUrl(url)}
          alt=""
          draggable={false}
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
          onError={() => {
            setFailedUrl(url);
          }}
        />
      ) : (
        <Film className="size-7 opacity-60" aria-hidden />
      )}
    </div>
  );
}

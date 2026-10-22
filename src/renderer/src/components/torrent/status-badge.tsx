import type { TorrentSummary } from "../../../../shared/engine-api";
import { Badge } from "@/components/ui/badge";

type Props = Pick<TorrentSummary, "status" | "progress" | "downloadSpeed">;

/** Finding peers / Checking / Downloading / Downloaded / Ready / Error. */
export function StatusBadge({ status, progress, downloadSpeed }: Props) {
  if (status === "fetching_metadata") {
    return (
      <Badge tone="info" dot>
        Finding peers
      </Badge>
    );
  }
  if (status === "checking") {
    return (
      <Badge tone="info" dot>
        Checking
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge tone="danger" dot>
        Error
      </Badge>
    );
  }
  if (progress >= 1) {
    return (
      <Badge tone="success" dot>
        Downloaded
      </Badge>
    );
  }
  if (downloadSpeed > 0) {
    return (
      <Badge tone="info" dot>
        Downloading
      </Badge>
    );
  }
  return (
    <Badge tone="success" dot>
      Ready
    </Badge>
  );
}

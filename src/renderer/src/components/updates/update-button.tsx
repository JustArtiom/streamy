import { ArrowDownToLine } from "lucide-react";
import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../../../shared/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useUpdateStatus } from "@/components/updates/update-status";
import { announce } from "@/lib/announcer";
import { runAction } from "@/lib/settings";
import { toast } from "@/lib/toast";

// A download icon in the title bar, next to Settings. It only shows when an
// update needs one click from the user:
//   ready (Windows, Linux AppImage): restarts into the downloaded version.
//   available (macOS): opens the release page. Unsigned Mac apps can't
//     update themselves, so the user downloads the new version.
// Checking, downloading and failed checks stay in Settings → Advanced.

type UpdateAction =
  { kind: "restart"; version: string } | { kind: "download"; version: string };

function updateAction(status: UpdateStatus | null): UpdateAction | null {
  if (status?.state === "ready") {
    return { kind: "restart", version: status.version };
  }
  if (status?.state === "available" && !status.canInstall) {
    return { kind: "download", version: status.version };
  }
  return null;
}

function labelFor(action: UpdateAction): string {
  return action.kind === "restart"
    ? `Restart to update to Streamy ${action.version}`
    : `Download Streamy ${action.version}`;
}

export function UpdateButton() {
  const action = updateAction(useUpdateStatus());
  const [restarting, setRestarting] = useState(false);
  const label = action ? labelFor(action) : null;

  // The button appears without moving focus, so screen readers hear it once
  // through the app's live region.
  useEffect(() => {
    if (!label) return;
    announce("update", `${label}: the button is next to Settings.`);
    return () => {
      announce("update", null);
    };
  }, [label]);

  if (!action || !label) return null;

  const restart = () => {
    setRestarting(true);
    // Streamy quits and the new version opens. If it doesn't, the button
    // comes back so the user can try again.
    void runAction(() => window.streamy.updates.install()).then((message) => {
      if (message) {
        setRestarting(false);
        toast.error("Couldn't restart to update", { description: message });
      }
    });
  };

  const download = () => {
    void runAction(() => window.streamy.updates.openReleasePage()).then(
      (message) => {
        if (message) {
          toast.error("Couldn't open the download page", {
            description: message,
          });
        }
      },
    );
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={restarting}
      aria-busy={restarting || undefined}
      className="text-success no-drag-region hover:text-success"
      onClick={action.kind === "restart" ? restart : download}
    >
      {restarting ? <Spinner size="sm" aria-hidden /> : <ArrowDownToLine />}
    </Button>
  );
}

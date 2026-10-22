import { Download, RotateCw } from "lucide-react";
import { useState } from "react";
import type { UpdateStatus } from "../../../../shared/api";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import {
  dismissUpdateNotice,
  useUpdateNoticeDismissed,
  useUpdateStatus,
} from "@/components/updates/update-status";
import { runAction } from "@/lib/settings";
import { toast } from "@/lib/toast";

// A calm note under the title bar, only when an update needs the user:
//   ready (Windows, AppImage): "Streamy 0.2.0 is ready."  [Restart to update]
//   available (macOS):         "Streamy 0.2.0 is available."  [Download]
// "Later" hides it until Streamy restarts, or until another version or step
// comes along. Downloads and failed checks stay in Settings → Advanced:
// there's nothing to do about them here.

type Notice = { key: string; kind: "ready" | "download"; version: string };

function noticeFor(status: UpdateStatus | null): Notice | null {
  if (status?.state === "ready") {
    return {
      key: `ready ${status.version}`,
      kind: "ready",
      version: status.version,
    };
  }
  if (status?.state === "available" && !status.canInstall) {
    return {
      key: `available ${status.version}`,
      kind: "download",
      version: status.version,
    };
  }
  return null;
}

const ACTION_CLASS = "h-7 bg-transparent px-2.5";

export function UpdateNotice() {
  const notice = noticeFor(useUpdateStatus());
  const isDismissed = useUpdateNoticeDismissed(notice?.key ?? null);
  const [restarting, setRestarting] = useState(false);

  if (!notice || isDismissed) return null;

  const later = (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 px-2.5"
      onClick={() => {
        dismissUpdateNotice(notice.key);
      }}
    >
      Later
    </Button>
  );

  if (notice.kind === "ready") {
    return (
      <Banner
        tone="info"
        title={`Streamy ${notice.version} is ready.`}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              className={ACTION_CLASS}
              loading={restarting}
              onClick={() => {
                setRestarting(true);
                // Streamy quits and the new version opens. If it doesn't,
                // the button comes back.
                void runAction(() => window.streamy.updates.install()).then(
                  (message) => {
                    if (message) {
                      setRestarting(false);
                      toast.error("Couldn't restart to update", {
                        description: message,
                      });
                    }
                  },
                );
              }}
            >
              {!restarting && <RotateCw />}
              Restart to update
            </Button>
            {later}
          </>
        }
      >
        It installs when Streamy restarts.
      </Banner>
    );
  }

  return (
    <Banner
      tone="info"
      title={`Streamy ${notice.version} is available.`}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            className={ACTION_CLASS}
            onClick={() => {
              void runAction(() =>
                window.streamy.updates.openReleasePage(),
              ).then((message) => {
                if (message) {
                  toast.error("Couldn't open the download page", {
                    description: message,
                  });
                }
              });
            }}
          >
            <Download />
            Download
          </Button>
          {later}
        </>
      }
    >
      Get it from its release page.
    </Banner>
  );
}

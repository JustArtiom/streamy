import { FileText, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import type { EngineStatus } from "../../../../shared/api";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { useEngineStatus } from "@/hooks/use-engine-status";
import { useHealth } from "@/hooks/use-health";
import { engineHasRun } from "@/lib/engine-status";
import { runAction, openSettings } from "@/lib/settings";
import { toast } from "@/lib/toast";

/** A normal launch takes a moment; only say something if it's slow. */
export const SLOW_START_MS = 3000;

/**
 * News about the playback engine, under the title bar: it's restarting, it
 * keeps crashing, or the disk is full. Nothing while all is well, and
 * nothing during a normal launch.
 */
export function EngineBanner() {
  const status = useEngineStatus();
  const slowStart = useSlowStart(status);
  const running = status === null || status.state === "running";
  // Asked only while the engine runs (it would fail otherwise).
  const health = useHealth();

  if (status?.state === "failed") {
    return (
      <Banner
        tone="danger"
        title="The playback engine keeps stopping."
        actions={<OpenLogsButton />}
      >
        Streamy will try again in a minute.
      </Banner>
    );
  }

  const hasRun = engineHasRun();
  if (
    status?.state === "restarting" ||
    (status?.state === "starting" && (hasRun || slowStart))
  ) {
    return (
      <Banner
        busy
        tone="warning"
        title={
          hasRun
            ? "Reconnecting to the playback engine…"
            : "Starting the playback engine…"
        }
      />
    );
  }

  if (running && health.data?.lowDiskSpace) {
    return (
      <Banner
        tone="warning"
        title="Your disk is almost full."
        actions={
          <Button
            size="sm"
            variant="outline"
            className="h-7 bg-transparent px-2.5"
            onClick={() => {
              openSettings("storage");
            }}
          >
            <HardDrive />
            Storage settings
          </Button>
        }
      >
        Downloading is paused; videos already downloaded still play.
      </Banner>
    );
  }

  return null;
}

/** True when the engine has been "starting" for longer than SLOW_START_MS. */
function useSlowStart(status: EngineStatus | null): boolean {
  // Which status object was found slow. Every change from the main process
  // is a new object, so a later "starting" begins its own wait.
  const [slowFor, setSlowFor] = useState<EngineStatus | null>(null);

  useEffect(() => {
    if (status?.state !== "starting") return;
    const id = setTimeout(() => {
      setSlowFor(status);
    }, SLOW_START_MS);
    return () => {
      clearTimeout(id);
    };
  }, [status]);

  return status !== null && slowFor === status;
}

function OpenLogsButton() {
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 bg-transparent px-2.5"
      onClick={() => {
        void runAction(() => window.streamy.openLogs()).then((message) => {
          if (message)
            toast.error("Couldn't open the logs", { description: message });
        });
      }}
    >
      <FileText />
      Open logs
    </Button>
  );
}

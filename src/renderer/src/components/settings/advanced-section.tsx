import {
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { EngineStatus, UpdateStatus } from "../../../../shared/api";
import { ENGINE_API_BASE, type Health } from "../../../../shared/engine-api";
import type { SettingsSnapshot } from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  checkForUpdates,
  useUpdateStatus,
} from "@/components/updates/update-status";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/cn";
import { formatRelativeTime } from "@/lib/format";
import { peopleText } from "@/lib/people-text";
import { runAction, settingsApi } from "@/lib/settings";

/** How often /v1/health is asked again while this section is open. */
const HEALTH_REFRESH_MS = 5_000;

/** The video encoders the engine may pick, by their ffmpeg names. */
const ENCODER_NAMES: Record<string, string> = {
  h264_videotoolbox: "VideoToolbox",
  h264_nvenc: "NVIDIA NVENC",
  h264_qsv: "Intel Quick Sync",
  h264_vaapi: "VA-API",
  h264_amf: "AMD AMF",
  h264_mf: "Media Foundation",
  h264_v4l2m2m: "V4L2",
  libx264: "CPU (x264)",
};

/** "8.1.3-Jellyfin" → "8.1.3". Unusual versions are shown as they are. */
function shortVersion(version: string): string {
  return /^n?(\d+(?:\.\d+)*)/.exec(version)?.[1] ?? version;
}

function isHealth(value: unknown): value is Health {
  if (typeof value !== "object" || value === null) return false;
  const { ffmpeg, encoder } = value as Record<string, unknown>;
  return (
    typeof ffmpeg === "object" &&
    ffmpeg !== null &&
    (typeof encoder === "string" || encoder === null)
  );
}

/** The engine's state, and its /v1/health while it runs. */
function useEngineInfo(): {
  status: EngineStatus | null;
  health: Health | null;
} {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let active = true;
    let heardChange = false;
    const unsubscribe = window.streamy.engine.onStatusChange((next) => {
      heardChange = true;
      setStatus(next);
    });
    window.streamy.engine
      .getStatus()
      .then((next) => {
        // A change that arrived meanwhile is newer than this answer.
        if (active && !heardChange) setStatus(next);
      })
      .catch((error: unknown) => {
        console.error(error);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const running = status?.state === "running";
  useEffect(() => {
    if (!running) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(`${ENGINE_API_BASE}/v1/health`, {
          signal: controller.signal,
        });
        const body: unknown = await response.json();
        if (response.ok && isHealth(body)) setHealth(body);
      } catch {
        // Stopped meanwhile, or not answering: the status says why.
      }
    };
    void load();
    // The encoder is detected a few seconds after the engine starts.
    const timer = setInterval(() => void load(), HEALTH_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
      // A restarted engine may have another ffmpeg or encoder.
      setHealth(null);
    };
  }, [running]);

  return { status, health: running ? health : null };
}

/** Streamy's version (from the main process), or null for a moment. */
function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    window.streamy
      .getAppInfo()
      .then((info) => {
        if (active) setVersion(info.version);
      })
      .catch((error: unknown) => {
        console.error(error);
      });
    return () => {
      active = false;
    };
  }, []);
  return version;
}

/**
 * "Streamy 0.1.0", what the updater is up to (src/main/updates), and the
 * button that fits: check, download (macOS), or restart to update.
 */
function UpdatesRow({
  autoCheck,
  onError,
}: {
  /** Settings → General → "Check for updates automatically". */
  autoCheck: boolean;
  onError: (message: string | null) => void;
}) {
  const version = useAppVersion();
  const status = useUpdateStatus();
  // "Checked 5 minutes ago" moves on while the section is open.
  const now = useNow(30_000);
  const [checking, setChecking] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const check = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      loading={checking || status?.state === "checking"}
      onClick={() => {
        setChecking(true);
        void runAction(checkForUpdates).then((message) => {
          setChecking(false);
          onError(message);
        });
      }}
    >
      {!checking && status?.state !== "checking" && <RefreshCw />}
      {label}
    </Button>
  );
  const openReleasePage = (label: string, icon: ReactNode) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        void runAction(() => window.streamy.updates.openReleasePage()).then(
          onError,
        );
      }}
    >
      {icon}
      {label}
    </Button>
  );

  const { text, action } = describeUpdates(status, now, autoCheck, {
    check,
    download: () => openReleasePage("Download", <Download />),
    releases: () => openReleasePage("Releases", <ExternalLink />),
    restart: () => (
      <Button
        size="sm"
        variant="outline"
        loading={restarting}
        onClick={() => {
          setRestarting(true);
          // Streamy quits and the new version opens.
          void runAction(() => window.streamy.updates.install()).then(
            (message) => {
              if (message) setRestarting(false);
              onError(message);
            },
          );
        }}
      >
        {!restarting && <RotateCw />}
        Restart to update
      </Button>
    ),
  });

  return (
    <SettingRow
      title={version ? `Streamy ${version}` : "Streamy"}
      description={
        // Announced when it changes ("Checking…", "Up to date…").
        <span aria-live="polite">{text}</span>
      }
    >
      {action}
    </SettingRow>
  );
}

interface UpdateButtons {
  check: (label: string) => ReactNode;
  download: () => ReactNode;
  releases: () => ReactNode;
  restart: () => ReactNode;
}

/** What the Updates row says and offers, for each state. */
function describeUpdates(
  status: UpdateStatus | null,
  now: number,
  autoCheck: boolean,
  buttons: UpdateButtons,
): { text: string | null; action: ReactNode } {
  switch (status?.state) {
    case undefined:
      return { text: null, action: null };
    case "unsupported":
      return {
        text: "This copy of Streamy doesn't update itself. New versions are on GitHub.",
        action: buttons.releases(),
      };
    case "idle": {
      const checked =
        status.checkedAt && formatRelativeTime(status.checkedAt, now);
      return {
        text: checked
          ? `Up to date. Checked ${checked}.`
          : autoCheck
            ? "Streamy checks for updates by itself."
            : "Automatic checks are off.",
        action: buttons.check("Check for updates"),
      };
    }
    case "checking":
      return {
        text: "Checking for updates…",
        action: buttons.check("Check for updates"),
      };
    case "available":
      return status.canInstall
        ? { text: `Downloading version ${status.version}…`, action: null }
        : {
            text: `Version ${status.version} is available.`,
            action: buttons.download(),
          };
    case "downloading":
      return {
        text: `Downloading version ${status.version}… ${status.percent}%`,
        action: null,
      };
    case "ready":
      return {
        text: `Version ${status.version} is ready. It installs when Streamy restarts.`,
        action: buttons.restart(),
      };
    case "error":
      return {
        // From the main process: a sentence, but never trusted blindly.
        text: peopleText(status.message, "Couldn't check for updates."),
        action: buttons.check("Try again"),
      };
  }
}

/**
 * THIRD_PARTY_NOTICES.txt (made by scripts/notices.mjs). The main process
 * serves it from the app's resources folder (see src/main/protocol.ts).
 */
const NOTICES_URL = "app://streamy/third-party-notices.txt";

type Notices = { text: string } | { error: string };

/** Third-party licences, as shipped with this copy of Streamy. */
function NoticesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const [notices, setNotices] = useState<Notices | null>(null);

  // Loaded the first time it opens, then kept (it's about half a megabyte).
  useEffect(() => {
    if (!open || notices !== null) return;
    const controller = new AbortController();
    fetch(NOTICES_URL, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(
        (text) => {
          setNotices({ text });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          console.error("Could not load the licences:", error);
          setNotices({
            error: import.meta.env.DEV
              ? "The licences file is missing. Run `npm run notices` to create it."
              : "The licences file is missing from this copy of Streamy.",
          });
        },
      );
    return () => {
      controller.abort();
    };
  }, [open, notices]);

  const close = () => {
    // A failed load is tried again next time.
    if (notices && "error" in notices) setNotices(null);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} size="lg" aria-labelledby={titleId}>
      <div className="flex max-h-[85dvh] flex-col">
        <div className="flex items-center justify-between gap-4 border-b border-border py-3 pr-3 pl-6">
          <h2 id={titleId} className="text-lg font-semibold">
            Third-party licences
          </h2>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close licences"
            onClick={close}
          >
            <X />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {notices === null ? (
            // Only while open: a closed dialog stays in the page.
            open && <Spinner tone="muted" label="Loading the licences" />
          ) : "error" in notices ? (
            <p role="alert" className="text-sm text-danger">
              {notices.error}
            </p>
          ) : (
            <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-muted-foreground select-text">
              {notices.text}
            </pre>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** "Running · ffmpeg 8.1.3 · VideoToolbox", or what's wrong. */
function EngineSummary({
  status,
  health,
}: {
  status: EngineStatus | null;
  health: Health | null;
}) {
  let summary: string;
  let problem: string | null = null;
  switch (status?.state) {
    case undefined:
      summary = "Checking…";
      break;
    case "starting":
      summary = "Starting…";
      break;
    case "restarting":
      summary = "Reconnecting…";
      problem =
        status.error && peopleText(status.error, "It stopped unexpectedly.");
      break;
    case "failed":
      summary = "Not running. Streamy tries again in a minute.";
      problem =
        status.error &&
        peopleText(status.error, "It keeps stopping. The logs say why.");
      break;
    case "running": {
      const parts = ["Running"];
      if (health?.ffmpeg.version) {
        parts.push(`ffmpeg ${shortVersion(health.ffmpeg.version)}`);
      } else if (health?.ffmpeg.error) {
        parts.push("ffmpeg isn't working");
        problem = peopleText(
          health.ffmpeg.error,
          "Videos that need converting won't play. The logs say why.",
        );
      }
      if (health?.encoder) {
        parts.push(ENCODER_NAMES[health.encoder] ?? health.encoder);
      }
      summary = parts.join(" · ");
      break;
    }
  }

  return (
    <>
      <span
        role="status"
        className={cn(
          "block",
          status?.state === "failed" ? "text-danger" : "text-foreground",
        )}
      >
        {summary}
      </span>
      {problem && <span className="mt-1 block text-danger">{problem}</span>}
    </>
  );
}

export function AdvancedSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { hardwareAcceleration } = snapshot.settings;
  const needsRestart =
    hardwareAcceleration !== snapshot.hardwareAccelerationActive;
  const engine = useEngineInfo();

  const [error, setError] = useState<string | null>(null);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  const reset = () => {
    setResetting(true);
    setResetError(null);
    void runAction(() => settingsApi.reset()).then((message) => {
      setResetting(false);
      setResetError(message);
      if (!message) setConfirmReset(false);
    });
  };

  return (
    <>
      <UpdatesRow
        autoCheck={snapshot.settings.checkForUpdates}
        onError={setError}
      />

      <SettingRow
        title="Hardware acceleration"
        description={
          <>
            Uses your graphics card for smoother video. Turn it off if video
            flickers or shows glitches.
            {needsRestart && (
              <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-foreground">
                Restart Streamy to apply this change.
                {/* In `npm run dev`, restarting would lose the dev server. */}
                {!import.meta.env.DEV && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      void runAction(() => window.streamy.relaunch()).then(
                        setError,
                      );
                    }}
                  >
                    <RotateCw />
                    Restart now
                  </Button>
                )}
              </span>
            )}
          </>
        }
      >
        {({ titleId, descriptionId }) => (
          <Switch
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            checked={hardwareAcceleration}
            onCheckedChange={(enabled) => {
              void runAction(() =>
                settingsApi.update({ hardwareAcceleration: enabled }),
              ).then(setError);
            }}
          />
        )}
      </SettingRow>

      <SettingRow
        title="Playback engine"
        description={<EngineSummary {...engine} />}
      >
        {null}
      </SettingRow>

      <SettingRow
        title="Logs"
        description="What Streamy and its playback engine did. Useful when reporting a problem."
      >
        <Button
          size="sm"
          variant="outline"
          aria-label="Open logs folder"
          onClick={() => {
            void runAction(() => window.streamy.openLogs()).then(setError);
          }}
        >
          <FolderOpen />
          Open
        </Button>
      </SettingRow>

      <SettingRow
        title="Data folder"
        description="Where Streamy keeps your settings."
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void runAction(() => settingsApi.openDataDir()).then(setError);
          }}
        >
          <FolderOpen />
          Open
        </Button>
      </SettingRow>

      <SettingRow
        title="Third-party licences"
        description="Streamy is built with software that many people made and share. Here's who, and under which licences."
      >
        <Button
          size="sm"
          variant="outline"
          aria-label="View third-party licences"
          onClick={() => {
            setNoticesOpen(true);
          }}
        >
          <FileText />
          View
        </Button>
      </SettingRow>

      <SettingRow
        title="Reset all settings"
        description="Puts every setting back to how it was when you installed Streamy. Your videos aren't deleted."
      >
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setResetError(null);
            setConfirmReset(true);
          }}
        >
          Reset…
        </Button>
      </SettingRow>

      {error && (
        <p role="alert" className="pt-2 text-sm text-danger">
          {error}
        </p>
      )}

      <NoticesDialog
        open={noticesOpen}
        onClose={() => {
          setNoticesOpen(false);
        }}
      />

      <ConfirmDialog
        open={confirmReset}
        title="Reset all settings?"
        description="Every setting goes back to its default. Your videos aren't deleted."
        confirmLabel="Reset"
        busy={resetting}
        error={resetError}
        onConfirm={reset}
        onClose={() => {
          setConfirmReset(false);
        }}
      />
    </>
  );
}

import {
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { UpdateStatus } from "../../../../shared/api";
import type { SettingsSnapshot } from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  checkForUpdates,
  useUpdateStatus,
} from "@/components/updates/update-status";
import { useNow } from "@/hooks/use-now";
import { formatRelativeTime } from "@/lib/format";
import { peopleText } from "@/lib/people-text";
import { runAction, settingsApi } from "@/lib/settings";

// About: which Streamy this is, its updates, and the software it's built
// with. (Things to fix problems with live in Advanced.)

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
  /** The "Check for updates automatically" switch below it. */
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

export function AboutSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { checkForUpdates: autoCheck } = snapshot.settings;
  const { electron, chrome, node } = window.streamy.versions;
  const [error, setError] = useState<string | null>(null);
  const [noticesOpen, setNoticesOpen] = useState(false);

  return (
    <>
      <UpdatesRow autoCheck={autoCheck} onError={setError} />

      <SettingRow
        title="Check for updates automatically"
        description="Asks GitHub for new versions when Streamy starts and every few hours."
      >
        {({ titleId, descriptionId }) => (
          <Switch
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            checked={autoCheck}
            onCheckedChange={(enabled) => {
              setError(null);
              void runAction(() =>
                settingsApi.update({ checkForUpdates: enabled }),
              ).then(setError);
            }}
          />
        )}
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
        title="Built with"
        description={`Electron ${electron} · Chromium ${chrome} · Node ${node}`}
      >
        {null}
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
    </>
  );
}

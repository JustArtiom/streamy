import { Folder, FolderOpen, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  CACHE_LIMIT_CHOICES_GB,
  type CacheUsage,
  type SettingsSnapshot,
} from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PathText } from "@/components/ui/path-text";
import { Select } from "@/components/ui/select";
import { formatBytes } from "@/lib/format";
import { platform } from "@/lib/platform";
import { runAction, settingsApi } from "@/lib/settings";

const REVEAL_LABEL = {
  darwin: "Show in Finder",
  win32: "Show in File Explorer",
  linux: "Show in file manager",
}[platform];

const NO_LIMIT = "none";

/** Space used by Streamy's videos, refreshed when the folder changes. */
function useCacheUsage(cacheDir: string) {
  const [usage, setUsage] = useState<CacheUsage | null>(null);

  const refresh = useCallback(() => {
    settingsApi
      .getCacheUsage()
      .then(setUsage)
      .catch((error: unknown) => {
        console.error(error);
      });
  }, []);

  // Re-measured whenever the folder changes.
  useEffect(() => {
    let active = true;
    settingsApi
      .getCacheUsage()
      .then((next) => {
        if (active) setUsage(next);
      })
      .catch((error: unknown) => {
        console.error(error);
      });
    return () => {
      active = false;
    };
  }, [cacheDir]);

  return { usage, refresh };
}

export function StorageSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { cacheDir, cacheLimitGb } = snapshot.settings;
  const isDefault = cacheDir === null;
  const path = cacheDir ?? snapshot.defaultCacheDir;
  const { usage, refresh } = useCacheUsage(path);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  /** Runs one folder action at a time and shows what went wrong, if anything. */
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void runAction(action).then((message) => {
      setError(message);
      setBusy(false);
    });
  };

  const clear = () => {
    setBusy(true);
    setClearError(null);
    void runAction(() => settingsApi.clearCache()).then((message) => {
      setBusy(false);
      setClearError(message);
      if (!message) setConfirmClear(false);
      refresh();
    });
  };

  const limitChoices: number[] = [...CACHE_LIMIT_CHOICES_GB];
  if (cacheLimitGb !== null && !limitChoices.includes(cacheLimitGb)) {
    limitChoices.push(cacheLimitGb); // e.g. edited by hand
    limitChoices.sort((a, b) => a - b);
  }

  return (
    <>
      <SettingRow
        stacked
        title="Video folder"
        description="Streamy keeps videos here while you watch them. Choose a drive with plenty of free space."
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5 rounded-md border border-border bg-muted px-3 py-2.5">
            <Folder className="mt-px size-4 shrink-0 text-muted-foreground" />
            <p className="min-w-0 flex-1 text-xs leading-5">
              <PathText path={path} />
            </p>
            {isDefault && (
              <span className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-5 text-muted-foreground">
                Default
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                run(() => settingsApi.chooseCacheDir());
              }}
            >
              Change…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                run(() => settingsApi.showCacheDir());
              }}
            >
              <FolderOpen />
              {REVEAL_LABEL}
            </Button>
            {!isDefault && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  run(() => settingsApi.resetCacheDir());
                }}
              >
                <RotateCcw />
                Use default
              </Button>
            )}
          </div>

          {snapshot.previousCacheDir && (
            <div className="flex flex-col items-start gap-2 rounded-md border border-border px-3 py-2.5 text-sm">
              <p className="text-muted-foreground">
                Videos already downloaded stay in the old folder:{" "}
                <PathText
                  path={snapshot.previousCacheDir}
                  className="text-xs text-foreground"
                />
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  run(() => settingsApi.showPreviousCacheDir());
                }}
              >
                <FolderOpen />
                Show old folder
              </Button>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </SettingRow>

      <SettingRow
        title="Space used"
        description={
          usage?.status === "missing"
            ? "The folder isn't available. If it's on an external drive, connect it."
            : "Videos you've watched. They download again if you watch them later."
        }
      >
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground tabular-nums">
            {usage?.status === "ok" ? formatBytes(usage.bytes) : "—"}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || usage?.status !== "ok" || usage.bytes === 0}
            onClick={() => {
              setClearError(null);
              setConfirmClear(true);
            }}
          >
            Clear now…
          </Button>
        </div>
      </SettingRow>

      <SettingRow
        title="Size limit"
        description="When videos take more space than this, or your disk is almost full, Streamy deletes the ones you watched longest ago."
      >
        {({ titleId, descriptionId }) => (
          <Select
            size="sm"
            className="w-36"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={cacheLimitGb === null ? NO_LIMIT : String(cacheLimitGb)}
            onChange={(event) => {
              const { value } = event.target;
              settingsApi
                .update({
                  cacheLimitGb: value === NO_LIMIT ? null : Number(value),
                })
                .catch((reason: unknown) => {
                  console.error(reason);
                });
            }}
          >
            {limitChoices.map((gb) => (
              <option key={gb} value={gb}>
                {gb} GB
              </option>
            ))}
            <option value={NO_LIMIT}>No limit</option>
          </Select>
        )}
      </SettingRow>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all videos?"
        description="This deletes the videos Streamy downloaded. They download again if you watch them later."
        confirmLabel="Clear videos"
        busy={busy}
        error={clearError}
        onConfirm={clear}
        onClose={() => {
          setConfirmClear(false);
        }}
      />
    </>
  );
}

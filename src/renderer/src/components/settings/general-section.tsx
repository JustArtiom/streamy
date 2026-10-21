import { useEffect, useState } from "react";
import type { SystemIntegration } from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Switch } from "@/components/ui/switch";
import { platform } from "@/lib/platform";
import { runAction, systemApi } from "@/lib/settings";

const ONLY_INSTALLED = "Only works in the installed app.";

export function GeneralSection() {
  const [system, setSystem] = useState<SystemIntegration | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    systemApi
      .get()
      .then((next) => {
        if (active) setSystem(next);
      })
      .catch((reason: unknown) => {
        console.error(reason);
      });
    return () => {
      active = false;
    };
  }, []);

  /** Changes an OS setting, then shows what the OS actually reports. */
  const change = (action: () => Promise<SystemIntegration>) => {
    setError(null);
    void runAction(async () => {
      setSystem(await action());
    }).then(setError);
  };

  if (!system) return null;

  // Linux can make Streamy the magnet handler but can't undo it.
  const magnetLocked = platform === "linux" && system.handlesMagnetLinks;

  return (
    <>
      <SettingRow
        title="Open at login"
        description={
          !system.available
            ? `Start Streamy when you sign in to your computer. ${ONLY_INSTALLED}`
            : system.openAtLoginNeedsApproval
              ? "Almost there: allow Streamy in System Settings → General → Login Items."
              : "Start Streamy when you sign in to your computer."
        }
      >
        {({ titleId, descriptionId }) => (
          <Switch
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            checked={system.openAtLogin}
            disabled={!system.available}
            onCheckedChange={(enabled) => {
              change(() => systemApi.setOpenAtLogin(enabled));
            }}
          />
        )}
      </SettingRow>

      <SettingRow
        title="Open magnet links with Streamy"
        description={
          !system.available
            ? `Clicking a magnet link in your browser opens it here. ${ONLY_INSTALLED}`
            : magnetLocked
              ? "To stop, choose another app for magnet links in your system settings."
              : "Clicking a magnet link in your browser opens it here."
        }
      >
        {({ titleId, descriptionId }) => (
          <Switch
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            checked={system.handlesMagnetLinks}
            disabled={!system.available || magnetLocked}
            onCheckedChange={(enabled) => {
              change(() => systemApi.setHandlesMagnetLinks(enabled));
            }}
          />
        )}
      </SettingRow>

      {error && (
        <p role="alert" className="pt-2 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
}

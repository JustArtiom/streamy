import { FolderOpen, RotateCw } from "lucide-react";
import { useState } from "react";
import type { SettingsSnapshot } from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Switch } from "@/components/ui/switch";
import { runAction, settingsApi } from "@/lib/settings";

export function AdvancedSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { hardwareAcceleration } = snapshot.settings;
  const needsRestart =
    hardwareAcceleration !== snapshot.hardwareAccelerationActive;

  const [error, setError] = useState<string | null>(null);
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

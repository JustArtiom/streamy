import { Monitor, Moon, Sun } from "lucide-react";
import {
  type SettingsSnapshot,
  type SettingsUpdate,
  type Theme,
  UI_SCALES,
} from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { isMac } from "@/lib/platform";
import { settingsApi } from "@/lib/settings";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

const SCALE_OPTIONS = UI_SCALES.map((scale) => ({
  value: String(scale),
  label: `${Math.round(scale * 100)}%`,
}));

function update(patch: SettingsUpdate) {
  settingsApi.update(patch).catch((error: unknown) => {
    console.error("Could not change the setting:", error);
  });
}

export function AppearanceSection({
  snapshot,
}: {
  snapshot: SettingsSnapshot;
}) {
  const { theme, uiScale } = snapshot.settings;
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <>
      <SettingRow
        title="Theme"
        description="System follows your computer's light or dark mode."
      >
        <SegmentedControl
          label="Theme"
          size="sm"
          options={THEME_OPTIONS}
          value={theme}
          onChange={(next) => {
            update({ theme: next });
          }}
        />
      </SettingRow>

      <SettingRow
        title="Interface size"
        description={`Makes everything bigger or smaller. Shortcuts: ${mod} + and ${mod} −.`}
      >
        <SegmentedControl
          label="Interface size"
          size="sm"
          options={SCALE_OPTIONS}
          value={String(uiScale)}
          onChange={(next) => {
            const scale = UI_SCALES.find((value) => String(value) === next);
            if (scale !== undefined) update({ uiScale: scale });
          }}
        />
      </SettingRow>
    </>
  );
}

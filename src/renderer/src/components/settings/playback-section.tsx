import {
  type SettingsSnapshot,
  type SettingsUpdate,
  SUBTITLES_OFF,
  type SubtitleBackground,
  type SubtitleColor,
  type SubtitleSize,
} from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { languageOptions } from "@/lib/languages";
import { settingsApi } from "@/lib/settings";
import {
  SUBTITLE_BACKGROUND_CLASS,
  SUBTITLE_COLOR_CLASS,
  SUBTITLE_SIZE_SCALE,
} from "@/lib/subtitle-style";

// <select> values can't be null, so "Automatic" gets a name of its own.
const AUTOMATIC = "auto";

const SIZE_OPTIONS: { value: SubtitleSize; label: string }[] = [
  { value: "s", label: "S" },
  { value: "m", label: "M" },
  { value: "l", label: "L" },
  { value: "xl", label: "XL" },
];

const BACKGROUND_OPTIONS: { value: SubtitleBackground; label: string }[] = [
  { value: "none", label: "None" },
  { value: "shadow", label: "Shadow" },
  { value: "box", label: "Box" },
];

const COLOR_OPTIONS: { value: SubtitleColor; label: string }[] = [
  { value: "white", label: "White" },
  { value: "yellow", label: "Yellow" },
];

function update(patch: SettingsUpdate) {
  settingsApi.update(patch).catch((error: unknown) => {
    console.error("Could not change the setting:", error);
  });
}

export function PlaybackSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const {
    audioLanguage,
    subtitleLanguage,
    subtitleSize,
    subtitleBackground,
    subtitleColor,
  } = snapshot.settings;

  // The current choices always appear, even if they aren't in the list
  // (e.g. a language picked in the player).
  const languages = languageOptions([
    audioLanguage,
    subtitleLanguage === SUBTITLES_OFF ? null : subtitleLanguage,
  ]);

  return (
    <>
      <SettingRow
        title="Audio language"
        description="Played when a video has several. Automatic uses the video's own choice."
      >
        {({ titleId, descriptionId }) => (
          <Select
            size="sm"
            className="w-44"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={audioLanguage ?? AUTOMATIC}
            onChange={(event) => {
              const { value } = event.target;
              update({ audioLanguage: value === AUTOMATIC ? null : value });
            }}
          >
            <option value={AUTOMATIC}>Automatic</option>
            {languages.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </SettingRow>

      <SettingRow
        title="Subtitles"
        description="Automatic shows them when the video says to, like for foreign-language parts."
      >
        {({ titleId, descriptionId }) => (
          <Select
            size="sm"
            className="w-44"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={subtitleLanguage ?? AUTOMATIC}
            onChange={(event) => {
              const { value } = event.target;
              update({
                subtitleLanguage: value === AUTOMATIC ? null : value,
              });
            }}
          >
            <option value={SUBTITLES_OFF}>Off</option>
            <option value={AUTOMATIC}>Automatic</option>
            {languages.map(({ code, name }) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        )}
      </SettingRow>

      <SettingRow stacked title="Subtitle style">
        <div className="flex flex-col gap-4">
          <SubtitlePreview
            size={subtitleSize}
            background={subtitleBackground}
            color={subtitleColor}
          />
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 text-sm">
            <span className="text-muted-foreground" aria-hidden>
              Size
            </span>
            <SegmentedControl
              label="Subtitle size"
              size="sm"
              className="w-fit"
              options={SIZE_OPTIONS}
              value={subtitleSize}
              onChange={(next) => {
                update({ subtitleSize: next });
              }}
            />
            <span className="text-muted-foreground" aria-hidden>
              Background
            </span>
            <SegmentedControl
              label="Subtitle background"
              size="sm"
              className="w-fit"
              options={BACKGROUND_OPTIONS}
              value={subtitleBackground}
              onChange={(next) => {
                update({ subtitleBackground: next });
              }}
            />
            <span className="text-muted-foreground" aria-hidden>
              Color
            </span>
            <SegmentedControl
              label="Subtitle color"
              size="sm"
              className="w-fit"
              options={COLOR_OPTIONS}
              value={subtitleColor}
              onChange={(next) => {
                update({ subtitleColor: next });
              }}
            />
          </div>
        </div>
      </SettingRow>
    </>
  );
}

/** A subtitle line over a dark "video", styled like the player shows it. */
function SubtitlePreview({
  size,
  background,
  color,
}: {
  size: SubtitleSize;
  background: SubtitleBackground;
  color: SubtitleColor;
}) {
  return (
    <div
      aria-hidden
      // A dusky gradient, so the shadow and box can be judged on a picture.
      className="flex h-28 items-end justify-center overflow-hidden rounded-md bg-linear-to-b from-slate-500 via-slate-700 to-slate-900 px-4 pb-4"
    >
      <p
        className={cn(
          "text-center leading-[1.3] font-medium",
          SUBTITLE_COLOR_CLASS[color],
        )}
        style={{ fontSize: `${(18 * SUBTITLE_SIZE_SCALE[size]).toFixed(1)}px` }}
      >
        <span
          className={cn(
            "box-decoration-clone",
            SUBTITLE_BACKGROUND_CLASS[background],
          )}
        >
          This is how subtitles will look.
        </span>
      </p>
    </div>
  );
}

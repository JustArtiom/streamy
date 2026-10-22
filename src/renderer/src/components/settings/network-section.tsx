import {
  KEEP_SHARING_CHOICES_MINUTES,
  MAX_CONNECTION_CHOICES,
  RATE_LIMIT_CHOICES_KBPS,
  type SettingsSnapshot,
  type SettingsUpdate,
} from "../../../../shared/settings";
import { SettingRow } from "@/components/settings/setting-row";
import { Select } from "@/components/ui/select";
import { formatRateLimit } from "@/lib/format";
import { settingsApi } from "@/lib/settings";

// <select> values are strings and can't be null, so null ("unlimited",
// "until Streamy quits") gets a name of its own.
const NONE = "none";

function update(patch: SettingsUpdate) {
  settingsApi.update(patch).catch((error: unknown) => {
    console.error("Could not change the setting:", error);
  });
}

/** The offered choices, plus the current value if it's another one. */
function withCurrent(choices: readonly number[], current: number | null) {
  const list = [...choices];
  if (current !== null && !list.includes(current)) {
    list.push(current); // e.g. edited by hand in settings.json
    list.sort((a, b) => a - b);
  }
  return list;
}

function sharingLabel(minutes: number): string {
  if (minutes === 0) return "Off";
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

export function NetworkSection({ snapshot }: { snapshot: SettingsSnapshot }) {
  const {
    downloadLimitKBps,
    uploadLimitKBps,
    keepSharingMinutes,
    maxConnections,
  } = snapshot.settings;

  const sharingChoices = withCurrent(
    KEEP_SHARING_CHOICES_MINUTES.filter((value) => value !== null),
    keepSharingMinutes,
  );

  return (
    <>
      <SettingRow
        title="Download limit"
        description="Leaves room for other apps on a slow connection. Videos may need to buffer more."
      >
        {({ titleId, descriptionId }) => (
          <RateLimitSelect
            titleId={titleId}
            descriptionId={descriptionId}
            value={downloadLimitKBps}
            onChange={(value) => {
              update({ downloadLimitKBps: value });
            }}
          />
        )}
      </SettingRow>

      <SettingRow
        title="Upload limit"
        description="How fast Streamy shares with other people."
      >
        {({ titleId, descriptionId }) => (
          <RateLimitSelect
            titleId={titleId}
            descriptionId={descriptionId}
            value={uploadLimitKBps}
            onChange={(value) => {
              update({ uploadLimitKBps: value });
            }}
          />
        )}
      </SettingRow>

      <SettingRow
        title="Keep sharing after watching"
        description="Torrents work because people share what they download. Sharing for a while afterwards is fair to them; Streamy stops when the time is up."
      >
        {({ titleId, descriptionId }) => (
          <Select
            size="sm"
            className="w-44"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={
              keepSharingMinutes === null ? NONE : String(keepSharingMinutes)
            }
            onChange={(event) => {
              const { value } = event.target;
              update({
                keepSharingMinutes: value === NONE ? null : Number(value),
              });
            }}
          >
            {sharingChoices.map((minutes) => (
              <option key={minutes} value={minutes}>
                {sharingLabel(minutes)}
              </option>
            ))}
            <option value={NONE}>Until Streamy quits</option>
          </Select>
        )}
      </SettingRow>

      <SettingRow
        title="Max connections"
        description="People each torrent connects to at once. Fewer can help a slow network or an old router."
      >
        {({ titleId, descriptionId }) => (
          <Select
            size="sm"
            className="w-44"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            value={String(maxConnections)}
            onChange={(event) => {
              update({ maxConnections: Number(event.target.value) });
            }}
          >
            {withCurrent(MAX_CONNECTION_CHOICES, maxConnections).map(
              (count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ),
            )}
          </Select>
        )}
      </SettingRow>
    </>
  );
}

function RateLimitSelect({
  titleId,
  descriptionId,
  value,
  onChange,
}: {
  titleId: string;
  descriptionId: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <Select
      size="sm"
      className="w-44"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      value={value === null ? NONE : String(value)}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === NONE ? null : Number(next));
      }}
    >
      <option value={NONE}>Unlimited</option>
      {withCurrent(RATE_LIMIT_CHOICES_KBPS, value).map((kbps) => (
        <option key={kbps} value={kbps}>
          {formatRateLimit(kbps)}
        </option>
      ))}
    </Select>
  );
}

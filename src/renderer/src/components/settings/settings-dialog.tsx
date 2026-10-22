import {
  Clapperboard,
  HardDrive,
  Info,
  type LucideIcon,
  Network,
  Palette,
  SlidersHorizontal,
  Wrench,
  X,
} from "lucide-react";
import { type ComponentType, useEffect, useId, useState } from "react";
import type { SettingsSnapshot } from "../../../../shared/settings";
import { AboutSection } from "@/components/settings/about-section";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { GeneralSection } from "@/components/settings/general-section";
import { NetworkSection } from "@/components/settings/network-section";
import { PlaybackSection } from "@/components/settings/playback-section";
import { StorageSection } from "@/components/settings/storage-section";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import {
  closeSettings,
  showSettingsSection,
  useSettings,
  useSettingsDialogOpen,
  useSettingsSection,
} from "@/lib/settings";

type Section = {
  id: string;
  label: string;
  icon: LucideIcon;
  Content: ComponentType<{ snapshot: SettingsSnapshot }>;
};

// New groups of settings go here. What goes where:
//   General     how Streamy fits into the computer (login, magnet links)
//   Appearance  how it looks
//   Playback    what you see and hear (languages, subtitles)
//   Storage     the video folder
//   Network     downloading and sharing
//   Advanced    graphics card switches, and what helps when something breaks
//   About       version, updates, licences
const SECTIONS: Section[] = [
  {
    id: "general",
    label: "General",
    icon: SlidersHorizontal,
    Content: GeneralSection,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
    Content: AppearanceSection,
  },
  {
    id: "playback",
    label: "Playback",
    icon: Clapperboard,
    Content: PlaybackSection,
  },
  { id: "storage", label: "Storage", icon: HardDrive, Content: StorageSection },
  { id: "network", label: "Network", icon: Network, Content: NetworkSection },
  { id: "advanced", label: "Advanced", icon: Wrench, Content: AdvancedSection },
  { id: "about", label: "About", icon: Info, Content: AboutSection },
];

/** The dialog's fade-out (Dialog's duration-150), plus a little. */
const CLOSE_ANIMATION_MS = 200;

/**
 * The sections are in the page only while the dialog is open (and while it
 * fades out), and each opening starts them fresh: "Space used" is measured
 * again, old errors are gone, and nothing keeps working in the background
 * (Advanced asks the engine for its health every few seconds).
 * Returns null while closed, else a key that changes with each opening.
 */
function useOpenSession(open: boolean): number | null {
  const [openings, setOpenings] = useState(open ? 1 : 0);
  const [shown, setShown] = useState(open);
  const [wasOpen, setWasOpen] = useState(open);
  // Adjusted while rendering (not in an effect), so the sections are there
  // in the very first frame of the dialog.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOpenings(openings + 1);
      setShown(true);
    }
  }

  useEffect(() => {
    if (open || !shown) return;
    const timer = setTimeout(() => {
      setShown(false);
    }, CLOSE_ANIMATION_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, shown]);

  return shown ? openings : null;
}

/** Opened from the title bar's gear, ⌘, / Ctrl+, or the app menu. */
export function SettingsDialog() {
  const open = useSettingsDialogOpen();
  const session = useOpenSession(open);
  const snapshot = useSettings();
  // In a store, so others can open a given section (openSettings("storage")).
  const sectionId = useSettingsSection();
  const titleId = useId();

  const section = SECTIONS.find((item) => item.id === sectionId) ?? SECTIONS[0];
  if (!section) return null;

  return (
    <Dialog
      open={open}
      onClose={closeSettings}
      size="lg"
      className="max-w-3xl"
      aria-labelledby={titleId}
    >
      <div className="flex h-[min(520px,80dvh)]">
        <nav
          aria-label="Settings sections"
          className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-muted p-2"
        >
          <h2 id={titleId} className="px-2 pt-1.5 pb-3 text-sm font-semibold">
            Settings
          </h2>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === section.id ? "page" : undefined}
              onClick={() => {
                showSettingsSection(item.id);
              }}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
                item.id === section.id
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <item.icon />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-border pr-2 pl-5">
            <h3 className="text-sm font-semibold">{section.label}</h3>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close settings"
              onClick={closeSettings}
            >
              <X />
            </Button>
          </header>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {session !== null &&
              (snapshot ? (
                <section.Content key={session} snapshot={snapshot} />
              ) : (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

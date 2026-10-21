import {
  HardDrive,
  type LucideIcon,
  Palette,
  SlidersHorizontal,
  Wrench,
  X,
} from "lucide-react";
import { type ComponentType, useId, useState } from "react";
import type { SettingsSnapshot } from "../../../../shared/settings";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { AppearanceSection } from "@/components/settings/appearance-section";
import { GeneralSection } from "@/components/settings/general-section";
import { StorageSection } from "@/components/settings/storage-section";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import {
  closeSettings,
  useSettings,
  useSettingsDialogOpen,
} from "@/lib/settings";

type Section = {
  id: string;
  label: string;
  icon: LucideIcon;
  Content: ComponentType<{ snapshot: SettingsSnapshot }>;
};

// New groups of settings go here.
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
  { id: "storage", label: "Storage", icon: HardDrive, Content: StorageSection },
  { id: "advanced", label: "Advanced", icon: Wrench, Content: AdvancedSection },
];

/** Opened from the title bar's gear, ⌘, / Ctrl+, or the app menu. */
export function SettingsDialog() {
  const open = useSettingsDialogOpen();
  const snapshot = useSettings();
  const [sectionId, setSectionId] = useState(SECTIONS[0]?.id);
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
                setSectionId(item.id);
              }}
              className={cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 [&_svg]:size-4 [&_svg]:shrink-0",
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
            {snapshot ? (
              <section.Content snapshot={snapshot} />
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

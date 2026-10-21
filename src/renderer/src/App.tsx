import { useEffect, useRef } from "react";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { TitleBar } from "@/components/title-bar";
import { VersionFooter } from "@/components/version-footer";
import { isModKey } from "@/lib/platform";
import { HomePage } from "@/pages/home";

// App-wide shortcuts like ⌘, (settings) and zoom live in the main process
// (menu.ts / shortcuts.ts). Only page-level ones are here.

export function App() {
  const magnetInput = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K jumps to the magnet input.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isModKey(event) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        magnetInput.current?.focus();
        magnetInput.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar />
      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <HomePage inputRef={magnetInput} />
        <VersionFooter className="mt-auto" />
      </main>
      <SettingsDialog />
    </div>
  );
}

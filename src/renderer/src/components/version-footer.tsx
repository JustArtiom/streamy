import { useEffect, useState } from "react";
import type { AppInfo } from "../../../shared/api";
import { cn } from "@/lib/cn";

/** "Streamy 0.1.0 · Electron … · Chromium … · Node …" */
export function VersionFooter({ className }: { className?: string }) {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void window.streamy.getAppInfo().then(setAppInfo);
  }, []);

  const { electron, chrome, node } = window.streamy.versions;
  const parts = [
    appInfo && `${appInfo.name} ${appInfo.version}`,
    `Electron ${electron}`,
    `Chromium ${chrome}`,
    `Node ${node}`,
  ].filter(Boolean);

  return (
    <footer
      className={cn(
        "px-6 py-5 text-center text-xs text-muted-foreground",
        className,
      )}
    >
      {parts.join(" · ")}
    </footer>
  );
}

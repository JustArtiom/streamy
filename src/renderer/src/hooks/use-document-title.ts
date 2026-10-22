import { useEffect } from "react";

/** "<title> · Streamy" while mounted; plain "Streamy" for null and after. */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · Streamy` : "Streamy";
    return () => {
      document.title = "Streamy";
    };
  }, [title]);
}

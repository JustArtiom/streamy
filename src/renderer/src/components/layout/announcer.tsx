import { useAnnouncements } from "@/lib/announcer";

/**
 * The app's one polite live region, always in the page (in AppLayout), so
 * screen readers hear the banners under the title bar as they come and
 * change. Invisible: the banners show the same text.
 */
export function Announcer() {
  const announcements = useAnnouncements();
  return (
    <div
      role="status"
      // Only what's new is read, not every banner again.
      aria-atomic="false"
      className="sr-only"
    >
      {announcements.map((item) => (
        <p key={item.id}>{item.text}</p>
      ))}
    </div>
  );
}

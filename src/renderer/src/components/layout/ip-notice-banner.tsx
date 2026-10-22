import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { dismissIpNotice, useIpNoticeVisible } from "@/lib/ip-notice";

/**
 * Shown once, after the first torrent is added, until dismissed: being in a
 * swarm means the other people in it can see your IP address.
 */
export function IpNoticeBanner() {
  const visible = useIpNoticeVisible();
  if (!visible) return null;

  return (
    <Banner
      tone="privacy"
      title="Peers can see your IP address while a torrent is active."
      actions={
        <Button
          size="sm"
          variant="outline"
          className="h-7 bg-transparent px-2.5"
          onClick={dismissIpNotice}
        >
          Got it
        </Button>
      }
    >
      That's how torrents work. A VPN keeps it private.
    </Banner>
  );
}

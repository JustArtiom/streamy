import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { AppLayout, type RouteHandle } from "@/components/layout/app-layout";
import { RouteError } from "@/components/layout/route-error";
import { HomePage } from "@/pages/home";
import { NotFoundPage } from "@/pages/not-found";
import { TorrentPage } from "@/pages/torrent";

const fullBleed: RouteHandle = { fullBleed: true };

/** Every page, inside the layout (title bar, banners, settings). */
export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { path: "/", element: <HomePage /> },
      // Older builds load the UI as /index.html: that's Home too.
      { path: "/index.html", element: <Navigate to="/" replace /> },
      { path: "/torrent/:infoHash", element: <TorrentPage /> },
      // The player fills the window under the title bar. Loaded on first
      // use: it brings hls.js, about as big as the rest of the UI.
      {
        path: "/watch/:infoHash/:fileIndex",
        handle: fullBleed,
        // Black while it loads (e.g. a reload on the player), like the player.
        hydrateFallbackElement: <div className="flex-1 bg-black" />,
        lazy: () =>
          import("@/pages/watch").then((module) => ({
            Component: module.WatchPage,
          })),
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}

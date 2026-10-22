import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  createMemoryRouter,
  type InitialEntry,
  RouterProvider,
} from "react-router";
import { Toaster } from "@/components/ui/toaster";
import { createQueryClient } from "@/lib/query-client";
import { routes } from "@/router";

type Options = {
  /** The URL the test starts on: "/torrent/abc" or { pathname, state }. */
  route?: InitialEntry;
  /** The route pattern `ui` is mounted at (for useParams). */
  path?: string;
  /** Keep the app's retry rules (default: no retries, failures show at once). */
  retries?: boolean;
};

function testQueryClient(retries: boolean) {
  const client = createQueryClient();
  if (!retries) {
    client.setDefaultOptions({
      queries: { retry: false },
      mutations: { retry: false },
    });
  }
  return client;
}

/**
 * Renders `ui` inside a fresh QueryClient and an in-memory router.
 * Navigating anywhere else lands on an empty page; read where it went
 * from `router.state.location`.
 */
export function renderWithProviders(
  ui: ReactNode,
  { route = "/", path = "/", retries = false }: Options = {},
) {
  const queryClient = testQueryClient(retries);
  const router = createMemoryRouter(
    [
      { path, element: ui },
      { path: "*", element: null },
    ],
    { initialEntries: [route] },
  );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );

  return { ...result, router, queryClient, user: userEvent.setup() };
}

/** The whole app (layout, title bar, every page), starting at `route`. */
export function renderApp({
  route = "/",
  retries = false,
}: Omit<Options, "path"> = {}) {
  const queryClient = testQueryClient(retries);
  const router = createMemoryRouter(routes, { initialEntries: [route] });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  );

  return { ...result, router, queryClient, user: userEvent.setup() };
}

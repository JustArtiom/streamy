import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { RouterProvider } from "react-router";
import { Toaster } from "@/components/ui/toaster";
import { createQueryClient } from "@/lib/query-client";
import { createAppRouter } from "@/router";

// App-wide shortcuts like ⌘, (settings) and zoom live in the main process
// (menu.ts / shortcuts.ts). Page-level ones live in their pages.

export function App() {
  // One of each for the app's lifetime (useState, so a re-render can't swap
  // them).
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(createAppRouter);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}

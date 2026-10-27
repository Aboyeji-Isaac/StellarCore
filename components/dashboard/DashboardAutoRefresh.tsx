"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { createDashboardPoller } from "@/lib/dashboard/polling";

/**
 * Re-reads the server-rendered dashboard on the documented interval while the
 * page is visible. Hidden documents keep no timer and issue no requests; the
 * poller cancels its timer and resumes per policy when the page is visible
 * again. This component renders nothing and owns no other state.
 */
export function DashboardAutoRefresh() {
  const router = useRouter();

  React.useEffect(() => {
    const poller = createDashboardPoller({ refresh: () => router.refresh() });
    poller.start();
    return () => poller.stop();
  }, [router]);

  return null;
}

import { useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { useHerdrStatus } from "@/lib/queries";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { reachability, subscribeReachability } from "@/web/connection";

export function HerdrBanner() {
  const status = useHerdrStatus();
  // While the Toodo server cannot be reached, its banner says so; herdr may be fine.
  const serverDown = useSyncExternalStore(subscribeReachability, reachability) !== "reachable";
  if (status.isPending || status.data?.running || serverDown) {
    return null;
  }
  const reason = status.isError ? status.error.message : "The herdr server is not running.";

  return (
    <div
      role="alert"
      className={cn("mb-4 flex items-center justify-between gap-3 rounded-lg px-3 py-2", tonePanel.attention)}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">herdr is not available</p>
        <p className="text-xs break-words">
          {reason} Start herdr, then retry. Tasks cannot be started until herdr is running.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={() => status.refetch()} disabled={status.isFetching}>
        {status.isFetching ? "Checking..." : "Retry"}
      </Button>
    </div>
  );
}

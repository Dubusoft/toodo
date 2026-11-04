import { useState, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tonePanel } from "@/lib/status-styles";
import { cn } from "@/lib/utils";
import { dismissNewBuild, newBuild, reloadIntoNewBuild, subscribeNewBuild } from "@/web/build";

/** Offers to reload once the server serves a newer build of the web app (see `src/web/build.ts`). */
export function UpdateBanner() {
  const build = useSyncExternalStore(subscribeNewBuild, newBuild);
  const [reloading, setReloading] = useState(false);
  if (build === null) {
    return null;
  }

  const reload = () => {
    setReloading(true);
    void reloadIntoNewBuild();
  };

  return (
    <div
      role="status"
      aria-label="New version of Toodo"
      className={cn(
        "fixed inset-x-2 top-2 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg p-3 text-sm shadow-md print:hidden",
        tonePanel.info,
      )}
    >
      <RefreshCw aria-hidden className="size-4 shrink-0" />
      <div className="min-w-0 flex-1 basis-48">
        <p className="font-medium">A new version of Toodo is available</p>
        <p className="text-xs">This tab still runs the earlier version. Reload to switch to the new one.</p>
      </div>
      <div className="flex gap-1 max-md:gap-2">
        <Button size="sm" disabled={reloading} onClick={reload}>
          {reloading ? "Reloading..." : "Reload"}
        </Button>
        <Button size="sm" variant="outline" disabled={reloading} onClick={dismissNewBuild}>
          Later
        </Button>
      </div>
    </div>
  );
}

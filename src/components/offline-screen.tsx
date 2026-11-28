import { useSyncExternalStore, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { WifiOff } from "lucide-react";
import { Button } from "@/components/button";
import { When } from "@/components/when";
import { fill, useMessages } from "@/lib/i18n";
import { queryKeys } from "@/lib/queries";
import { reachability, retryNow, signInExpired, subscribeReachability, unreachableCause } from "@/web/connection";

/**
 * Tells while `toodo-server` does not answer and takes the banner away once it answers
 * again. The app stays mounted underneath, so what was loaded stays readable and nothing
 * typed or selected is lost; buttons that change data are disabled meanwhile (see
 * `src/components/button.tsx`). What was loaded may come from an earlier visit (see
 * `src/web/query-cache.ts`), so the banner tells when.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(subscribeReachability, reachability);
  const offline = state === "unreachable" || state === "retrying";
  return (
    <>
      {offline && <OfflineBanner retrying={state === "retrying"} />}
      {children}
      {/* Room to scroll the end of the page out from under the banner. */}
      {offline && <div aria-hidden className="h-40" />}
    </>
  );
}

function OfflineBanner({ retrying }: { retrying: boolean }) {
  const m = useMessages();
  const copy = m.app.offline;
  const reason = navigator.onLine ? unreachableCause(m) : copy.deviceOffline;
  // Only a reload signs in to the proxy again, so waiting for an answer would never end.
  const signIn = navigator.onLine && signInExpired();
  const loadedAt = useQueryClient().getQueryState(queryKeys.tasks)?.dataUpdatedAt;
  return (
    <div
      role="alert"
      className="fixed inset-x-2 bottom-2 z-50 mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-500 bg-amber-100 p-3 text-sm text-amber-950 shadow-md dark:bg-amber-950 dark:text-amber-100"
    >
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {signIn ? copy.signIn : copy.unreachable}
        </p>
        <p className="text-xs">
          {reason}{" "}
          {loadedAt ? fill(copy.readOnly, { when: <When at={Math.floor(loadedAt / 1000)} /> }) : copy.stale}{" "}
          {signIn ? copy.pausedSignIn : copy.paused}
        </p>
      </div>
      {signIn ? (
        <Button size="sm" variant="secondary" label={m.app.reload} onClick={() => location.reload()} />
      ) : (
        <Button
          size="sm"
          variant="secondary"
          label={retrying ? copy.trying : m.app.retryNow}
          isDisabled={retrying}
          onClick={retryNow}
        />
      )}
    </div>
  );
}

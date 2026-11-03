import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  disablePush,
  enablePush,
  getPushState,
  pushSupport,
  saveSettings,
  sendTest,
  type PushSettings,
  type PushState,
  type PushSupport,
  type ServerSubscription,
} from "@/web/push";

const pushKey = ["push"];

const settingOptions = [
  { key: "agent", label: "Agent finished or needs input" },
  { key: "pullRequests", label: "Pull request checks and reviews" },
  { key: "completion", label: "Task awaiting completion" },
] as const satisfies readonly { key: keyof PushSettings; label: string }[];

const unavailable: Record<Exclude<PushSupport, "supported">, string> = {
  "needs-install": "Add Toodo to the Home Screen to get notifications (iOS 16.4 or later).",
  unsupported: "This browser cannot get notifications from Toodo.",
};

function summary({ subscription, permission }: PushState): string {
  return subscription ? "on" : permission === "denied" ? "blocked" : "off";
}

function PushControls({ state }: { state: PushState }) {
  const queryClient = useQueryClient();
  const show = (subscription: ServerSubscription | null) =>
    queryClient.setQueryData<PushState>(pushKey, (current) => current && { ...current, subscription });
  // A refused permission or a lost subscription changes what the panel offers.
  const recheck = () => queryClient.invalidateQueries({ queryKey: pushKey });
  const enable = useMutation({
    mutationFn: (permission: Promise<NotificationPermission>) => enablePush(permission, state.publicKey),
    onSuccess: show,
    onError: recheck,
  });
  const disable = useMutation({ mutationFn: disablePush, onSuccess: () => show(null), onError: recheck });
  const save = useMutation({ mutationFn: saveSettings, onSuccess: show });
  const test = useMutation({ mutationFn: sendTest });
  // Only the outcome of the latest action shows.
  const latest = [enable, disable, save, test].reduce((last, mutation) =>
    mutation.submittedAt > last.submittedAt ? mutation : last,
  );
  // Browsers only ask for permission while a click is handled, so the click asks first.
  const askAndEnable = () => enable.mutate(Notification.requestPermission());
  const { subscription } = state;
  // While a change saves, the boxes already show it.
  const settings = (save.isPending ? save.variables : undefined) ?? subscription?.settings;

  return (
    <>
      {subscription && settings ? (
        <>
          <p className="font-medium">Notifications are on for this device.</p>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-muted-foreground">Notify about</legend>
            {settingOptions.map(({ key, label }) => (
              <label key={key} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={settings[key]}
                  disabled={save.isPending}
                  onChange={(event) => save.mutate({ ...settings, [key]: event.target.checked })}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap gap-1">
            <Button changesData size="xs" variant="outline" disabled={test.isPending} onClick={() => test.mutate()}>
              Send test notification
            </Button>
            <Button
              changesData
              size="xs"
              variant="ghost"
              aria-label="Disable notifications on this device"
              disabled={disable.isPending}
              onClick={() => disable.mutate()}
            >
              Disable notifications
            </Button>
          </div>
        </>
      ) : state.permission === "denied" ? (
        <p>Notifications are blocked for Toodo in the browser settings. Allow them there to turn them on.</p>
      ) : (
        <>
          <p className="font-medium">Notifications are off for this device.</p>
          <Button
            size="xs"
            className="self-start"
            aria-label="Enable notifications on this device"
            disabled={enable.isPending}
            onClick={askAndEnable}
          >
            Enable notifications
          </Button>
        </>
      )}
      {latest === test && test.isSuccess && (
        <p role="status" className="text-muted-foreground">
          Test notification sent.
        </p>
      )}
      {latest.error && (
        <p role="alert" className="break-words text-destructive">
          {latest.error.message}
        </p>
      )}
    </>
  );
}

function usePushState() {
  // Whether the browser can get pushes does not change while the page is open.
  const [support] = useState(pushSupport);
  const state = useQuery({ queryKey: pushKey, queryFn: getPushState, enabled: support === "supported" });
  return { support, state };
}

/** Whether notifications are on for this device, shown next to the Notifications settings once known. */
export function NotificationsStatus() {
  const { state } = usePushState();
  return state.data ? <>{summary(state.data)}</> : null;
}

export function NotificationsPanel() {
  const { support, state } = usePushState();

  return (
    <section aria-label="Notifications" className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {support === "supported" ? "Alerts reach this device even while Toodo is closed." : unavailable[support]}
      </p>
      {state.isLoading && <p className="text-muted-foreground">Checking this device...</p>}
      {state.error && (
        <p role="alert" className="break-words text-destructive">
          {state.error.message}
        </p>
      )}
      {state.data && <PushControls state={state.data} />}
    </section>
  );
}

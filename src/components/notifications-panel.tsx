import { useState } from "react";
import { useI18n, useMessages } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Button } from "@/components/button";
import { serverText } from "@/lib/server-text";
import { formatFull, formatWhen } from "@/lib/timeline";
import {
  disablePush,
  enablePush,
  getPushState,
  pushSupport,
  saveSettings,
  sendTest,
  type PushFailure,
  type PushSettings,
  type PushState,
  type ServerSubscription,
} from "@/web/push";

const pushKey = ["push"];

/** The settings in the sections they show in, each one notification the server decides to send. */
const settingSections = [
  { section: "chat", keys: ["important", "messages"] },
  { section: "tasks", keys: ["started", "completion", "finished"] },
] as const satisfies readonly { section: string; keys: readonly (keyof PushSettings)[] }[];

/** Why notifications stopped reaching this device, and what to try. */
function LastFailure({ failure }: { failure: PushFailure }) {
  const { locale, m } = useI18n();
  const t = m.settings.pushPanel;
  return (
    <div role="note" aria-label={t.deliveryNote} className="flex flex-col gap-0.5 rounded-md border border-destructive/40 p-2">
      <p className="font-medium">{t.notDelivered}</p>
      <p className="break-words text-muted-foreground">
        <time dateTime={new Date(failure.at * 1000).toISOString()} title={formatFull(failure.at, locale)}>
          {formatWhen(failure.at, undefined, locale, m)}
        </time>
        : {serverText(failure.message, m, locale)}
      </p>
      <p className="text-muted-foreground">
        {t.retryHelp}
      </p>
    </div>
  );
}

function PushControls({ state }: { state: PushState }) {
  const m = useMessages();
  const t = m.settings.pushPanel;
  const queryClient = useQueryClient();
  const show = (subscription: ServerSubscription | null) =>
    queryClient.setQueryData<PushState>(pushKey, (current) => current && { ...current, subscription });
  // A refused permission or a lost subscription changes what the panel offers.
  const recheck = () => queryClient.invalidateQueries({ queryKey: pushKey });
  const enable = useMutation({
    mutationFn: (permission: Promise<NotificationPermission>) => enablePush(permission, state.publicKey, t),
    onSuccess: show,
    onError: recheck,
  });
  const disable = useMutation({ mutationFn: disablePush, onSuccess: () => show(null), onError: recheck });
  const save = useMutation({ mutationFn: (settings: PushSettings) => saveSettings(settings, t), onSuccess: show });
  // A test notification records its outcome as the device's last delivery failure or clears it.
  const test = useMutation({ mutationFn: sendTest, onSettled: recheck });
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
          <p className="font-medium">{t.enabled}</p>
          {subscription.lastFailure && <LastFailure failure={subscription.lastFailure} />}
          {settingSections.map(({ section, keys }) => (
            <fieldset key={section} className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">{t.sections[section]}</legend>
              {keys.map((key) => (
                <CheckboxInput
                  key={key}
                  label={t.options[key].label}
                  description={t.options[key].description}
                  value={settings[key]}
                  isDisabled={save.isPending}
                  onChange={(checked) => save.mutate({ ...settings, [key]: checked })}
                />
              ))}
            </fieldset>
          ))}
          <div className="flex flex-wrap gap-1">
            <Button
              changesData
              size="sm"
              variant="secondary"
              label={t.test}
              isDisabled={test.isPending}
              onClick={() => test.mutate()}
            />
            <Button
              changesData
              size="sm"
              variant="ghost"
              label={t.disableDevice}
              isDisabled={disable.isPending}
              onClick={() => disable.mutate()}
            >
              {t.disable}
            </Button>
          </div>
        </>
      ) : state.permission === "denied" ? (
        <p>{t.blockedHelp}</p>
      ) : (
        <>
          <p className="font-medium">{t.disabled}</p>
          <Button
            size="sm"
            variant="primary"
            className="self-start"
            label={t.enableDevice}
            isDisabled={enable.isPending}
            onClick={askAndEnable}
          >
            {t.enable}
          </Button>
        </>
      )}
      {latest === test && test.isSuccess && (
        <p role="status" className="text-muted-foreground">
          {t.sent}
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
  const m = useMessages();
  const t = m.settings.pushPanel;
  // Whether the browser can get pushes does not change while the page is open.
  const [support] = useState(pushSupport);
  const state = useQuery({ queryKey: pushKey, queryFn: () => getPushState(t), enabled: support === "supported" });
  return { support, state };
}

/** Whether notifications are on for this device, shown next to the Notifications settings once known. */
export function NotificationsStatus() {
  const m = useMessages();
  const t = m.settings.pushPanel;
  const { state } = usePushState();
  return state.data ? <>{state.data.subscription ? t.status.on : state.data.permission === "denied" ? t.status.blocked : t.status.off}</> : null;
}

export function NotificationsPanel() {
  const m = useMessages();
  const t = m.settings.pushPanel;
  const { support, state } = usePushState();

  return (
    <section aria-label={m.settings.sections.notifications} className="break-words-keep flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {support === "supported" ? t.supported : t.unavailable[support]}
      </p>
      {state.isLoading && <p className="text-muted-foreground">{t.checking}</p>}
      {state.error && (
        <p role="alert" className="break-words text-destructive">
          {state.error.message}
        </p>
      )}
      {state.data && <PushControls state={state.data} />}
    </section>
  );
}

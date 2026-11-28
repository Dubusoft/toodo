import { useState } from "react";
import { useI18n, useMessages } from "@/lib/i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/button";
import { formatFull, formatWhen } from "@/lib/timeline";
import { escapeCloses } from "@/components/workspace-list";
import { guessDeviceLabel, listDevices, registerDevice, revokeDevice, type Device } from "@/web/devices";
import { setToken } from "@/web/session";

const devicesKey = ["devices"];

/** How this browser is signed in: as a listed device, or with the shared token, which it can trade for its own. */
function ThisBrowser({ devices }: { devices: Device[] }) {
  const m = useMessages();
  const t = m.settings.devicesPanel;
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: () => registerDevice(guessDeviceLabel(navigator.userAgent, m)),
    onSuccess: (token) => {
      setToken(token);
      return queryClient.invalidateQueries({ queryKey: devicesKey });
    },
  });
  const current = devices.find((device) => device.current);

  return (
    <div role="group" aria-label={t.thisBrowser} className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5">
      <p>
        <span className="text-muted-foreground">{t.thisBrowserPrefix}</span>
        <span className="font-medium break-words">{current ? current.label : t.shared}</span>
      </p>
      {!current && (
        <>
          <p className="text-muted-foreground">{t.registerHelp}</p>
          <Button
            changesData
            size="sm"
            variant="secondary"
            className="self-start"
            label={register.isPending ? t.registering : t.register}
            isDisabled={register.isPending}
            onClick={() => register.mutate()}
          />
        </>
      )}
      {register.error && (
        <p role="alert" className="break-words text-destructive">
          {register.error.message}
        </p>
      )}
    </div>
  );
}


function DeviceRow({ device }: { device: Device }) {
  const { locale, m } = useI18n();
  const t = m.settings.devicesPanel;
  const time = (at: number, label: (relative: string) => string) => (
    <time dateTime={new Date(at * 1000).toISOString()} title={formatFull(at, locale)}>{label(formatWhen(at, undefined, locale, m))}</time>
  );
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeDevice(device.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devicesKey }),
  });
  const revoked = device.revokedAt !== null;

  return (
    <li aria-label={t.device(device.label)} data-revoked={revoked} className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className={revoked ? "truncate text-muted-foreground line-through" : "truncate font-medium"}>
          {device.label}
        </span>
        {device.current && <span className="text-muted-foreground">{t.current}</span>}
        {device.scope === "read" && <span className="text-muted-foreground">{t.readOnly}</span>}
      </span>
      <span className="text-muted-foreground">
        {device.revokedAt !== null ? (
          time(device.revokedAt, t.revoked)
        ) : (
          <>
            {time(device.lastSeenAt, t.lastSeen)}
            {" \u00b7 "}
            {device.expiresAt === null ? (
              t.noExpiry
            ) : (
              time(device.expiresAt, device.expiresAt * 1000 <= Date.now() ? t.expired : t.expires)
            )}
          </>
        )}
      </span>
      {!revoked &&
        (confirming ? (
          <div
            role="alertdialog"
            aria-label={t.confirm(device.label)}
            className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
            onKeyDown={escapeCloses(() => setConfirming(false), revoke.isPending)}
          >
            <p>
              {device.current
                ? t.revokeCurrent
                : t.revokeOther}
            </p>
            <div className="flex gap-1">
              <Button
                changesData
                size="sm"
                variant="destructive"
                label={t.revoke}
                isDisabled={revoke.isPending}
                onClick={() => revoke.mutate()}
              />
              <Button size="sm" variant="ghost" label={t.keep} autoFocus onClick={() => setConfirming(false)} />
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            label={t.revokeNamed(device.label)}
            onClick={() => setConfirming(true)}
          >
            {t.revoke}
          </Button>
        ))}
      {revoke.error && (
        <p role="alert" className="break-words text-destructive">
          {revoke.error.message}
        </p>
      )}
    </li>
  );
}

/**
 * How many browsers are signed in, shown next to the Devices settings once known: the
 * devices whose tokens still work, plus this browser when it signed in without a device of
 * its own (with the shared token), since it is signed in too but not listed.
 */
export function DevicesStatus() {
  const m = useMessages();
  const t = m.settings.devicesPanel;
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices });
  if (!devices.data) return null;
  const now = Date.now() / 1000;
  const signedIn = devices.data.filter((device) => device.revokedAt === null && (device.expiresAt === null || device.expiresAt > now));
  const unlisted = devices.data.some((device) => device.current) ? 0 : 1;
  return <>{t.signedIn(signedIn.length + unlisted)}</>;
}

export function DevicesPanel() {
  const m = useMessages();
  const t = m.settings.devicesPanel;
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices });

  return (
    <section aria-label={m.settings.sections.devices} className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        {t.intro}
      </p>
      {devices.error && (
        <p role="alert" className="break-words text-destructive">
          {devices.error.message}
        </p>
      )}
      {devices.data && <ThisBrowser devices={devices.data} />}
      {devices.data && (
        <ul aria-label={t.list} className="flex flex-col gap-2">
          {devices.data.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      )}
    </section>
  );
}

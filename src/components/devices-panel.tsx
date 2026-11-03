import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { When } from "@/components/when";
import { escapeCloses } from "@/components/workspace-list";
import { guessDeviceLabel, listDevices, registerDevice, revokeDevice, type Device } from "@/web/devices";
import { setToken } from "@/web/session";

const devicesKey = ["devices"];

/** How this browser is signed in: as a listed device, or with the shared token, which it can trade for its own. */
function ThisBrowser({ devices }: { devices: Device[] }) {
  const queryClient = useQueryClient();
  const register = useMutation({
    mutationFn: () => registerDevice(guessDeviceLabel(navigator.userAgent)),
    onSuccess: (token) => {
      setToken(token);
      return queryClient.invalidateQueries({ queryKey: devicesKey });
    },
  });
  const current = devices.find((device) => device.current);

  return (
    <div role="group" aria-label="This browser" className="flex flex-col gap-1 rounded-md bg-muted px-2 py-1.5">
      <p>
        <span className="text-muted-foreground">This browser: </span>
        <span className="font-medium break-words">{current ? current.label : "shared token"}</span>
      </p>
      {!current && (
        <>
          <p className="text-muted-foreground">Register it to give it a token of its own that you can revoke alone.</p>
          <Button
            changesData
            size="xs"
            variant="outline"
            className="self-start"
            disabled={register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending ? "Registering..." : "Register this browser"}
          </Button>
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
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => revokeDevice(device.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: devicesKey }),
  });
  const revoked = device.revokedAt !== null;

  return (
    <li aria-label={`Device ${device.label}`} data-revoked={revoked} className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5">
        <span className={revoked ? "truncate text-muted-foreground line-through" : "truncate font-medium"}>
          {device.label}
        </span>
        {device.current && <span className="text-muted-foreground">(this device)</span>}
      </span>
      <span className="text-muted-foreground">
        {device.revokedAt !== null ? (
          <When at={device.revokedAt} prefix="Revoked " />
        ) : (
          <When at={device.lastSeenAt} prefix="Last seen " />
        )}
      </span>
      {!revoked &&
        (confirming ? (
          <div
            role="alertdialog"
            aria-label={`Confirm revoke of ${device.label}`}
            className="flex flex-col gap-1 rounded-md border border-destructive/40 p-2"
            onKeyDown={escapeCloses(() => setConfirming(false), revoke.isPending)}
          >
            <p>
              {device.current
                ? "This browser signs out and needs the shared token to sign in again."
                : "The device's token stops working for good."}
            </p>
            <div className="flex gap-1">
              <Button changesData size="xs" variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
                Revoke
              </Button>
              <Button size="xs" variant="ghost" autoFocus onClick={() => setConfirming(false)}>
                Keep
              </Button>
            </div>
          </div>
        ) : (
          <Button size="xs" variant="outline" className="self-start" aria-label={`Revoke ${device.label}`} onClick={() => setConfirming(true)}>
            Revoke
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

/** How many devices are signed in, shown next to the Devices settings once known. */
export function DevicesStatus() {
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices });
  if (!devices.data) return null;
  return <>{devices.data.filter((device) => device.revokedAt === null).length} signed in</>;
}

export function DevicesPanel() {
  const devices = useQuery({ queryKey: devicesKey, queryFn: listDevices });

  return (
    <section aria-label="Devices" className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">
        Each browser signs in with the shared token once and then keeps its own token. Revoke a lost device here.
      </p>
      {devices.error && (
        <p role="alert" className="break-words text-destructive">
          {devices.error.message}
        </p>
      )}
      {devices.data && <ThisBrowser devices={devices.data} />}
      {devices.data && (
        <ul aria-label="Signed-in devices" className="flex flex-col gap-2">
          {devices.data.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
        </ul>
      )}
    </section>
  );
}

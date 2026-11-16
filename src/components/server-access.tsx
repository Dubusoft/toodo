import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Button } from "@/components/button";
import { DEFAULT_ACCESS, guessDeviceLabel, LIFETIMES, signIn, TokenRejected, type DeviceScope } from "@/web/devices";
import { checkAccess, isSignedIn, setToken, subscribeToken } from "@/web/session";

/**
 * Shows the app once the browser holds an access token the server accepts, or Cloudflare
 * Access in front of the server signs it in; otherwise a form asks for the token. Signing in
 * with the shared token from `web-token` in the server's data directory registers this
 * browser as a device with a token of its own.
 */
export function ServerAccess({ children }: { children: ReactNode }) {
  const signedIn = useSyncExternalStore(subscribeToken, isSignedIn);
  const [askedAccess, setAskedAccess] = useState(false);
  useEffect(() => {
    if (signedIn) return;
    let current = true;
    checkAccess()
      .catch((error: unknown) => console.warn("toodo: could not ask the server about Cloudflare Access", error))
      .finally(() => {
        if (current) setAskedAccess(true);
      });
    return () => {
      current = false;
      setAskedAccess(false);
    };
  }, [signedIn]);
  if (signedIn) return children;
  return askedAccess ? <TokenForm /> : null;
}

const scopeOptions = [
  { value: "full", label: "Full access" },
  { value: "read", label: "Read-only" },
];

const lifetimeOptions = LIFETIMES.map(({ label, days }) => ({ value: days === null ? "never" : String(days), label }));

function TokenForm() {
  const [token, setDraft] = useState("");
  const [label, setLabel] = useState(() => guessDeviceLabel(navigator.userAgent));
  const [scope, setScope] = useState<DeviceScope>(DEFAULT_ACCESS.scope);
  const [lifetime, setLifetime] = useState(String(DEFAULT_ACCESS.expiresInDays));
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [checking, setChecking] = useState(false);
  const tokenField = useRef<HTMLInputElement>(null);
  const id = useId();
  const helpId = `${id}-help`;
  const rejectedId = `${id}-rejected`;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    setRejected(false);
    try {
      const expiresInDays = lifetime === "never" ? null : Number(lifetime);
      setToken(await signIn(token.trim(), label.trim(), { scope, expiresInDays }));
    } catch (failure) {
      if (failure instanceof TokenRejected) {
        setRejected(true);
        tokenField.current?.focus();
        tokenField.current?.select();
      } else if (failure instanceof TypeError) {
        setError(`Could not reach the server: ${String(failure)}`);
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <form onSubmit={submit} aria-label="Server access" className="flex w-full max-w-sm flex-col gap-3 rounded-lg border p-5">
        <h1 className="text-lg font-semibold">Toodo server</h1>
        <p className="text-sm text-muted-foreground">
          Sign in with the server's access token. This browser then gets a token of its own, which you can revoke under Devices.
        </p>
        <div className="flex flex-col gap-1">
          <TextInput
            ref={tokenField}
            label="Access token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(value) => {
              setDraft(value);
              setRejected(false);
            }}
            status={rejected ? { type: "error" } : undefined}
            aria-describedby={rejected ? `${rejectedId} ${helpId}` : helpId}
          />
          {rejected && (
            <p id={rejectedId} role="alert" className="text-xs text-destructive">
              The server did not accept this token. Paste the whole contents of{" "}
              <code className="text-xs">web-token</code> again; a device token stops working once it is revoked.
            </p>
          )}
          <p id={helpId} className="text-xs text-muted-foreground">
            Copy it from <code className="text-xs">web-token</code> in the server's data directory.
          </p>
        </div>
        <TextInput
          label="Device name"
          description="Signing in again under a device's name replaces that device, so give each browser its own name."
          value={label}
          onChange={(value) => setLabel(value.slice(0, 80))}
        />
        <div className="grid grid-cols-2 gap-2">
          <Selector
            label="Access"
            options={scopeOptions}
            value={scope}
            onChange={(value) => setScope(value as DeviceScope)}
          />
          <Selector label="Token expires after" options={lifetimeOptions} value={lifetime} onChange={setLifetime} />
        </div>
        <p className="text-xs text-muted-foreground">
          Applies when you sign in with <code className="text-xs">web-token</code>. When the token expires, sign in again.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          label={checking ? "Checking..." : "Continue"}
          isDisabled={checking || !token.trim() || !label.trim()}
        />
      </form>
    </main>
  );
}

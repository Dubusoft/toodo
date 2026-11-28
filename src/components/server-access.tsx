import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { fill, useMessages } from "@/lib/i18n";
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

function TokenForm() {
  const m = useMessages();
  const t = m.settings.serverAccess;
  const scopeOptions = [{ value: "full", label: t.full }, { value: "read", label: m.settings.readOnly }];
  const lifetimeOptions = LIFETIMES.map(({ label, days }) => ({ value: days === null ? "never" : String(days), label: t.lifetimes[label] }));
  const [token, setDraft] = useState("");
  const [label, setLabel] = useState(() => guessDeviceLabel(navigator.userAgent, m));
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
        setError(t.unreachable(String(failure)));
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setChecking(false);
    }
  }

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
      <form onSubmit={submit} aria-label={t.region} className="break-words-keep flex w-full max-w-sm flex-col gap-3 rounded-lg border p-5">
        <h1 className="text-lg font-semibold">{t.title}</h1>
        <p className="text-sm text-muted-foreground">
          {t.intro}
        </p>
        <div className="flex flex-col gap-1">
          <TextInput
            ref={tokenField}
            label={t.token}
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
              {fill(t.rejected, { token: <code className="text-xs">web-token</code> })}
            </p>
          )}
          <p id={helpId} className="text-xs text-muted-foreground">
            {fill(t.copyToken, { token: <code className="text-xs">web-token</code> })}
          </p>
        </div>
        <TextInput
          label={t.device}
          description={t.deviceHint}
          value={label}
          onChange={(value) => setLabel(value.slice(0, 80))}
        />
        <div className="grid grid-cols-2 gap-2">
          <Selector
            label={t.access}
            options={scopeOptions}
            value={scope}
            onChange={(value) => setScope(value as DeviceScope)}
          />
          <Selector label={t.expiry} options={lifetimeOptions} value={lifetime} onChange={setLifetime} />
        </div>
        <p className="text-xs text-muted-foreground">
          {fill(t.expiryHelp, { token: <code className="text-xs">web-token</code> })}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button
          type="submit"
          variant="primary"
          label={checking ? t.checking : t.continue}
          isDisabled={checking || !token.trim() || !label.trim()}
        />
      </form>
    </main>
  );
}

import { useId, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/workspace-list";
import { guessDeviceLabel, signIn, TokenRejected } from "@/web/devices";
import { getToken, setToken, subscribeToken } from "@/web/session";

/**
 * Shows the app once the browser holds an access token the server accepts; until then,
 * a form asks for it. Signing in with the shared token from `web-token` in the server's
 * data directory registers this browser as a device with a token of its own.
 */
export function ServerAccess({ children }: { children: ReactNode }) {
  const token = useSyncExternalStore(subscribeToken, getToken);
  return token === null ? <TokenForm /> : children;
}

function TokenForm() {
  const [token, setDraft] = useState("");
  const [label, setLabel] = useState(() => guessDeviceLabel(navigator.userAgent));
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
      setToken(await signIn(token.trim(), label.trim()));
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
          <label htmlFor={`${id}-token`} className="text-xs text-muted-foreground">
            Access token
          </label>
          <input
            ref={tokenField}
            id={`${id}-token`}
            className={`${inputClass} aria-invalid:border-destructive`}
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => {
              setDraft(event.target.value);
              setRejected(false);
            }}
            aria-invalid={rejected || undefined}
            aria-describedby={rejected ? `${rejectedId} ${helpId}` : helpId}
            required
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
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Device name
          <input
            className={inputClass}
            maxLength={80}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={checking || !token.trim() || !label.trim()}>
          {checking ? "Checking..." : "Continue"}
        </Button>
      </form>
    </main>
  );
}

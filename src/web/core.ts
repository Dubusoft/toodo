/**
 * Runs commands on `toodo-server`: the generated bindings invoke commands through `invoke`,
 * which posts them to the server.
 */
import { LocalizedError } from "@/lib/error-messages";
import { serverFetch } from "@/web/connection";
import { credentials, forgetToken, proxyRefused, rejectedByServer } from "@/web/session";

type CommandError = { kind: string; code: string; message: string };

/** How long a command may take, answer included: a request a dead connection holds never ends. */
const INVOKE_TIMEOUT_MS = 30_000;

function isCommandError(value: unknown): value is CommandError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CommandError).kind === "string" &&
    typeof (value as CommandError).code === "string" &&
    typeof (value as CommandError).message === "string"
  );
}

/**
 * Runs a command on the server. It resolves with the result and
 * rejects with the command's error object (not an `Error`), which the bindings turn into
 * `{ status: "error" }`; transport failures reject with an `Error`, and so does a command
 * the server does not answer within `INVOKE_TIMEOUT_MS`.
 */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const signedIn = credentials();
  if (signedIn === null) {
    throw new LocalizedError((m) => m.app.connection.noToken);
  }
  // A timer of its own rather than `AbortSignal.timeout`, so that fake timers drive it in tests.
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), INVOKE_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await serverFetch(`/api/rpc/${encodeURIComponent(command)}`, {
      method: "POST",
      headers: { ...signedIn, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: timeout.signal,
    });
    if (response.status === 401) {
      if (!(await rejectedByServer(response))) throw proxyRefused();
      forgetToken();
      throw new LocalizedError((m) => m.app.connection.tokenRejected);
    }
    text = await response.text();
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new LocalizedError((m) => m.app.connection.commandTimedOut(command, INVOKE_TIMEOUT_MS / 1000));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) {
    return (text ? JSON.parse(text) : null) as T;
  }
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: e.g. a proxy's error page.
  }
  if (isCommandError(body)) {
    throw body;
  }
  throw new Error(text || `${response.status} ${response.statusText}`);
}


/**
 * Runs commands on `toodo-server`: the generated bindings invoke commands through `invoke`,
 * which posts them to the server.
 */
import { serverFetch } from "@/web/connection";
import { credentials, forgetToken, proxyRefused, rejectedByServer } from "@/web/session";

type CommandError = { kind: string; code: string; message: string };

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
 * `{ status: "error" }`; transport failures reject with an `Error`.
 */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const signedIn = credentials();
  if (signedIn === null) {
    throw new Error("No access token for the Toodo server.");
  }
  const response = await serverFetch(`/api/rpc/${encodeURIComponent(command)}`, {
    method: "POST",
    headers: { ...signedIn, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (response.status === 401) {
    if (!(await rejectedByServer(response))) throw proxyRefused();
    forgetToken();
    throw new Error("The Toodo server did not accept the access token.");
  }
  const text = await response.text();
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


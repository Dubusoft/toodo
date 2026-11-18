/**
 * How this browser signs in to `toodo-server`: with the access token kept in local storage for
 * each server (this browser's device token, or the shared web token when this browser signed in
 * before devices existed), or through Cloudflare Access in front of the server, which signs every
 * request in without a token when the server is configured for it. Every API request bears the
 * token when there is one. A token the server itself rejects is forgotten, so the app asks for it
 * again; a 401 from a proxy in front of the server leaves it alone.
 */
import type { CommandError } from "@/lib/bindings";
import { serverFetch } from "@/web/connection";
import { activeServer } from "@/web/server";

const STORAGE_KEY = activeServer.key("toodo-server-token");

/** What `toodo-server`'s own 401 answers for `/api` start with. */
const SERVER_REJECTION = "Toodo API:";

const listeners = new Set<() => void>();

/** Whether Cloudflare Access signs this browser in, as the server last said. */
let throughAccess = false;

function changed() {
  listeners.forEach((listener) => listener());
}

export function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
  changed();
}

/** Signs this browser out: forgets the token and that Cloudflare Access signed it in. */
export function forgetToken(): void {
  localStorage.removeItem(STORAGE_KEY);
  throughAccess = false;
  changed();
}

/** Whether this browser has a token or Cloudflare Access signs it in. */
export function isSignedIn(): boolean {
  return throughAccess || getToken() !== null;
}

/** Calls `listener` whenever the token or the sign-in through Cloudflare Access changes. */
export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** The headers that sign a request in, or `null` while signed out. */
export function credentials(): Record<string, string> | null {
  const token = getToken();
  if (token !== null) return authorization(token);
  return throughAccess ? {} : null;
}

/**
 * Whether `response` is `toodo-server` refusing the request's token. A proxy in front of the
 * server, such as Cloudflare Access whose session ran out, can answer 401 as well; that says
 * nothing about the token.
 */
export async function rejectedByServer(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  return (await response.clone().text()).startsWith(SERVER_REJECTION);
}

/** The error for a 401 that did not come from `toodo-server`. */
export function proxyRefused(): Error {
  return new Error("A proxy in front of the Toodo server refused the request (401). Reload the app to sign in to it again.");
}

/**
 * Asks the server whether Cloudflare Access signed this request in, and if so signs this browser
 * in that way; resolves with whether it did.
 */
export async function checkAccess(): Promise<boolean> {
  const response = await serverFetch("/api/session", { cache: "no-store" });
  if (!response.ok) {
    void response.body?.cancel();
    return false;
  }
  const { via } = (await response.json()) as { via?: string };
  if (via !== "access") return false;
  throughAccess = true;
  changed();
  return true;
}

/**
 * Requests `path` on the server, signed in. A token the server rejects is forgotten;
 * other failures throw with the server's message.
 */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const signedIn = credentials();
  if (signedIn === null) {
    throw new Error("No access token for the Toodo server.");
  }
  const response = await serverFetch(path, { ...init, headers: { ...signedIn, ...init.headers } });
  if (response.status === 401) {
    if (!(await rejectedByServer(response))) throw proxyRefused();
    forgetToken();
    throw new Error("The Toodo server did not accept the access token.");
  }
  if (!response.ok) {
    throw new Error(await failureMessage(response));
  }
  return response;
}

/** The message of a failed response: the `CommandError` message, or the body as text. */
export async function failureMessage(response: Response): Promise<string> {
  const text = await response.text();
  let message = text || `${response.status} ${response.statusText}`;
  try {
    message = (JSON.parse(text) as CommandError).message ?? message;
  } catch {
    // Not JSON: the server's own message, e.g. an upload over the size limit.
  }
  return message;
}

/**
 * The access token of `toodo-server`, kept in local storage for each server: this browser's
 * device token, or the shared web token when this browser signed in before devices existed. Every API
 * request bears it; a request the server rejects forgets it, so the app asks for it again.
 */
import type { CommandError } from "@/lib/bindings";
import { serverFetch } from "@/web/connection";
import { activeServer } from "@/web/server";

const STORAGE_KEY = activeServer.key("toodo-server-token");

const listeners = new Set<() => void>();

export function getToken(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token);
  listeners.forEach((listener) => listener());
}

export function forgetToken(): void {
  localStorage.removeItem(STORAGE_KEY);
  listeners.forEach((listener) => listener());
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function authorization(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Requests `path` on the server with the stored token. A rejected token is forgotten;
 * other failures throw with the server's message.
 */
export async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  if (token === null) {
    throw new Error("No access token for the Toodo server.");
  }
  const response = await serverFetch(path, { ...init, headers: { ...authorization(token), ...init.headers } });
  if (response.status === 401) {
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

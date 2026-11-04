/**
 * Devices of `toodo-server`: each browser signs in once with the shared web token and
 * then keeps a token of its own, which can be revoked without touching other devices.
 */
import { activeServer } from "@/web/server";
import { apiRequest, authorization, failureMessage } from "@/web/session";

export interface Device {
  id: number;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  /** When the device's token stops working on its own; `null` if it never does. */
  expiresAt: number | null;
  /** A `read` device may only read; the server refuses its changes. */
  scope: DeviceScope;
  /** Whether this is the device that asked, i.e. this browser. */
  current: boolean;
}

export type DeviceScope = "full" | "read";

/** What a new device's token may do and how many days it lasts (`null`: it never expires). */
export interface DeviceAccess {
  scope: DeviceScope;
  expiresInDays: number | null;
}

export const DEFAULT_ACCESS: DeviceAccess = { scope: "full", expiresInDays: 90 };

/** The lifetimes the web app offers, the server's default first. */
export const LIFETIMES: { label: string; days: number | null }[] = [
  { label: "90 days", days: 90 },
  { label: "30 days", days: 30 },
  { label: "1 year", days: 365 },
  { label: "Never expires", days: null },
];

function registration(label: string, access: DeviceAccess): string {
  return JSON.stringify({ label, scope: access.scope, expiresInDays: access.expiresInDays });
}

export class TokenRejected extends Error {
  constructor() {
    super("The server did not accept this token.");
  }
}

async function checked(response: Response): Promise<Response> {
  if (response.status === 401) throw new TokenRejected();
  if (!response.ok) throw new Error(await failureMessage(response));
  return response;
}

/**
 * Signs this browser in with `token` and resolves with the token to keep: a device token
 * is kept as it is, and the shared web token registers a new device named `label` with
 * `access`.
 */
export async function signIn(token: string, label: string, access: DeviceAccess = DEFAULT_ACCESS): Promise<string> {
  const listed = await checked(await activeServer.fetch("/api/devices", { headers: authorization(token) }));
  const devices = (await listed.json()) as Device[];
  if (devices.some((device) => device.current)) return token;
  const created = await checked(
    await activeServer.fetch("/api/devices", {
      method: "POST",
      headers: { ...authorization(token), "Content-Type": "application/json" },
      body: registration(label, access),
    }),
  );
  return ((await created.json()) as { token: string }).token;
}

export async function listDevices(): Promise<Device[]> {
  return (await (await apiRequest("/api/devices")).json()) as Device[];
}

/**
 * Registers this browser, signed in with the shared web token, as a device named `label`
 * and resolves with the device's own token. The server rejects it for a device token.
 */
export async function registerDevice(label: string, access: DeviceAccess = DEFAULT_ACCESS): Promise<string> {
  const response = await apiRequest("/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: registration(label, access),
  });
  return ((await response.json()) as { token: string }).token;
}

export async function revokeDevice(id: number): Promise<Device> {
  const response = await apiRequest(`/api/devices/${id}/revoke`, { method: "POST" });
  return (await response.json()) as Device;
}

/** A name for this browser to start from, e.g. "Chrome on Android". */
export function guessDeviceLabel(userAgent: string): string {
  const browser =
    [
      ["Edg/", "Edge"],
      ["Firefox/", "Firefox"],
      ["Chrome/", "Chrome"],
      ["Safari/", "Safari"],
    ].find(([marker]) => userAgent.includes(marker))?.[1] ?? "Browser";
  const system = [
    ["Android", "Android"],
    ["iPhone", "iOS"],
    ["iPad", "iPadOS"],
    ["Windows", "Windows"],
    ["Mac OS", "macOS"],
    ["Linux", "Linux"],
  ].find(([marker]) => userAgent.includes(marker))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

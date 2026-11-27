// Per-device access tokens for `/api`, and the gate every `/api` request passes. Port of
// `src-tauri/src/server/devices.rs`.
//
// Every request bears either the shared web token (`web-token` in the data directory) or
// the token of a device that is not revoked. The shared token registers devices: a browser
// signs in with it once and then keeps a token of its own, which can be revoked alone. A
// device token cannot register more devices, so a lost device's token cannot outlive its
// revocation through another one. A device token expires on its own after the lifetime it
// was registered with, and a read-only one may only read. With Cloudflare Access
// configured, a request with a valid Access JWT needs no token: it counts as the device
// whose token it bears, else as the `access` caller. A token that works decides alone, so
// Access does not lift a read-only device's limits.
//
// - `GET /api/devices` lists every device, marking the one that asks.
// - `POST /api/devices` with `{ "label": string, "scope"?: "full" | "read",
//   "expiresInDays"?: number | null }` registers a device and returns
//   `{ "device": ..., "token": string }`; the token is shown only this once.
// - `POST /api/devices/{id}/revoke` revokes a device for good.
// - `GET /api/session` tells how the request signed in: `{ "via": "token" | "access" }`.

import { commandError, invalidInput, rejected } from "../commands/errors.ts";
import {
  DEFAULT_LIFETIME_DAYS,
  type Device,
  DeviceLabel,
  DeviceLabelError,
  type DeviceId,
  deviceScopeAsStr,
  MAX_LIFETIME_DAYS,
} from "../domain/device.ts";
import { authenticateDevice, createDevice, listDevices, markDeviceSeen, revokeDevice } from "../storage/devices.ts";
import type { AccessVerifier } from "./access.ts";
import {
  bearer,
  type Caller,
  expired,
  failed,
  type FailedAttempts,
  json,
  readOnlyAllows,
  readOnlyRefused,
  sameSecret,
  tokenHash,
  tooMany,
  unauthorized,
} from "./auth.ts";
import { badArguments, READ_COMMANDS } from "./rpc.ts";
import type { Services } from "./services.ts";
import { randomToken } from "./tokens.ts";

/** What `/api` requests are checked against. */
export type Gate = {
  readonly services: Services;
  readonly sharedToken: string;
  /** The MCP token, which `/api` rejects with a reason of its own. */
  readonly mcpToken: string;
  readonly attempts: FailedAttempts;
  /** Checks Cloudflare Access JWTs, when the server is configured for them. */
  readonly access: AccessVerifier | null;
};

/** Why `byToken` refused a request: `unauthenticated` when Access may still sign it in,
 * `final` when an active device may not make it or its token could not be checked. */
type Refused = { readonly kind: "unauthenticated" | "final"; readonly response: Response };

/**
 * The caller of a request that bears the shared token or an active device's token that may
 * make it, or a valid Cloudflare Access JWT; otherwise the response refusing it. A device's
 * last-seen time moves with it.
 */
export async function requireAccess(gate: Gate, request: Request, path: string, peer: string): Promise<Caller | Response> {
  const throughAccess = gate.access === null ? false : await gate.access.admits(request.headers);
  const found = byToken(gate, request, path, peer, throughAccess);
  if ("response" in found) {
    return found.kind === "unauthenticated" && throughAccess ? { kind: "access" } : found.response;
  }
  return found;
}

/** The caller the request's token stands for. Wrong tokens count towards the lockout unless
 * Access signed the request in. */
function byToken(gate: Gate, request: Request, path: string, peer: string, throughAccess: boolean): Caller | Refused {
  const refuse = (response: Response): Refused => ({ kind: "unauthenticated", response });
  if (!throughAccess) {
    const wait = gate.attempts.lockedOut(peer);
    if (wait !== null) return refuse(tooMany("API", wait));
  }
  const presented = bearer(request.headers);
  if (presented === "no_header" || presented === "not_bearer") return refuse(unauthorized("api", presented, null));
  if (sameSecret(presented, gate.sharedToken)) return { kind: "shared" };
  if (sameSecret(presented, gate.mcpToken)) return refuse(unauthorized("api", "other_surface_token", null));
  const { services } = gate;
  let auth;
  try {
    // The lookup runs on the reader, so a request waits for the writer only when the
    // device's last-seen time is stale.
    auth = authenticateDevice(services.reader.db, tokenHash(presented), services.reader.now());
    if (auth.kind === "active" && auth.seenIsStale) {
      markDeviceSeen(services.storage.db, auth.device.id, services.storage.now());
    }
  } catch (error) {
    return { kind: "final", response: failed(commandError(error)) };
  }
  switch (auth.kind) {
    case "active":
      if (auth.device.scope === "read_only" && !readOnlyAllows(request.method, path, auth.device.id, READ_COMMANDS)) {
        return { kind: "final", response: readOnlyRefused() };
      }
      return { kind: "device", id: auth.device.id };
    case "expired":
      return refuse(expired());
    case "unknown":
      if (!throughAccess) gate.attempts.record(peer);
      return refuse(unauthorized("api", "wrong_token", null));
  }
}

export function session(caller: Caller): Response {
  return json(200, { via: caller.kind === "access" ? "access" : "token" });
}

function deviceView(device: Device, caller: Caller) {
  return {
    id: device.id,
    label: device.label.value,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
    revokedAt: device.revokedAt,
    expiresAt: device.expiresAt,
    scope: deviceScopeAsStr(device.scope),
    current: caller.kind === "device" && caller.id === device.id,
  };
}

/** Runs `run`, answering with a failure as the command error it is. */
function answer(run: () => Response): Response {
  try {
    return run();
  } catch (error) {
    return failed(commandError(error));
  }
}

export function list(services: Services, caller: Caller): Response {
  return answer(() => json(200, listDevices(services.storage.db).map((device) => deviceView(device, caller))));
}

type NewDevice = { label: string; scope: "full" | "read"; expiresInDays: number | null };

/** The body of `POST /api/devices` as serde reads it, or the message of its rejection. */
function newDevice(body: string): NewDevice | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid type, expected struct NewDevice";
  const { label, scope = "full", expiresInDays = DEFAULT_LIFETIME_DAYS } = value as Record<string, unknown>;
  if (label === undefined) return "missing field `label`";
  if (typeof label !== "string") return "invalid type, expected a string";
  if (scope !== "full" && scope !== "read") {
    return typeof scope === "string" ? `unknown variant \`${scope}\`, expected \`full\` or \`read\`` : "invalid type, expected enum ScopeInput";
  }
  if (expiresInDays !== null && !(Number.isInteger(expiresInDays) && (expiresInDays as number) >= 0 && (expiresInDays as number) <= 0xffff_ffff)) {
    return `invalid value: ${JSON.stringify(expiresInDays)}, expected u32`;
  }
  return { label, scope, expiresInDays: expiresInDays as number | null };
}

export function register(services: Services, caller: Caller, body: string): Response {
  const asked = newDevice(body);
  if (typeof asked === "string") return badArguments(asked);
  if (caller.kind === "device") {
    return json(
      403,
      rejected("only the shared web token or Cloudflare Access can register a device; sign in with it on the new device"),
    );
  }
  let label: DeviceLabel;
  try {
    label = DeviceLabel.parse(asked.label);
  } catch (error) {
    if (error instanceof DeviceLabelError) return failed(invalidInput(error.message));
    throw error;
  }
  const lifetime = asked.expiresInDays;
  if (lifetime !== null && !(lifetime >= 1 && lifetime <= MAX_LIFETIME_DAYS)) {
    return failed(
      invalidInput(`expiresInDays must be from 1 to ${MAX_LIFETIME_DAYS}; send null for a token that does not expire`),
    );
  }
  return answer(() => {
    const token = randomToken();
    const device = createDevice(
      services.storage.db,
      { label, tokenHash: tokenHash(token), scope: asked.scope === "read" ? "read_only" : "full", lifetimeDays: lifetime },
      services.storage.now(),
    );
    return json(201, { device: deviceView(device, caller), token });
  });
}

export function revoke(services: Services, caller: Caller, id: DeviceId): Response {
  return answer(() => json(200, deviceView(revokeDevice(services.storage.db, id, services.storage.now()), caller)));
}


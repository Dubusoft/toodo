// The Web Push routes of a signed-in device.
//
// - `GET /api/push`: the server's public key and the asking device's subscription.
// - `PUT /api/push/subscription` with a browser's `PushSubscription` subscribes the device;
//   `DELETE` unsubscribes it.
// - `PUT /api/push/settings` with `{ completion, messages?, important?, started?, finished? }`
//   chooses what it is told about.
// - `POST /api/push/test` sends it a test notification.
//
// Notifications are per device: a browser signed in with the shared token or Cloudflare
// Access alone gets `403` for the routes that need one.

import { CommandError, commandError, invalidInput, notFound, rejected } from "../commands/errors.ts";
import type { DeviceId } from "../domain/device.ts";
import { DEFAULT_PUSH_SETTINGS, type PushSettings, type PushSubscription } from "../domain/push.ts";
import { parseSubscription, PushInputError, PushTestError, sendTest, type SubscriptionInput } from "../push/push.ts";
import { deletePushSubscription, pushSubscription, savePushSubscription, setPushSettings } from "../storage/push.ts";
import { type Caller, failed, json } from "./auth.ts";
import { badArguments } from "./rpc.ts";
import type { Services } from "./services.ts";

function subscriptionView(subscription: PushSubscription) {
  return {
    endpoint: subscription.endpoint.url,
    settings: {
      completion: subscription.settings.completion,
      messages: subscription.settings.messages,
      important: subscription.settings.important,
      started: subscription.settings.started,
      finished: subscription.settings.finished,
    },
    lastFailure:
      subscription.lastFailure === null
        ? null
        : { message: subscription.lastFailure.message, at: subscription.lastFailure.at },
  };
}

/** The asking device, or the `403` for a browser signed in with the shared token or
 * Cloudflare Access alone. */
function device(caller: Caller): DeviceId | Response {
  if (caller.kind === "device") return caller.id;
  return json(
    403,
    rejected("notifications are per device; sign in on this device with the shared web token to get a device token"),
  );
}

function answer(run: () => unknown): Response {
  try {
    return json(200, run() ?? null);
  } catch (error) {
    return failed(commandError(error));
  }
}

export function state(services: Services, caller: Caller): Response {
  return answer(() => {
    const subscription = caller.kind === "device" ? pushSubscription(services.storage.db, caller.id) : null;
    return {
      publicKey: services.push.publicKey(),
      subscription: subscription === null ? null : subscriptionView(subscription),
    };
  });
}

/** A browser's `PushSubscription` JSON as serde reads it, or the message of its rejection. */
function subscriptionInput(body: string): SubscriptionInput | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid type, expected struct SubscriptionInput";
  const { endpoint, keys } = value as Record<string, unknown>;
  if (endpoint === undefined) return "missing field `endpoint`";
  if (typeof endpoint !== "string") return "invalid type, expected a string";
  if (keys === undefined) return "missing field `keys`";
  if (keys === null || typeof keys !== "object" || Array.isArray(keys)) return "invalid type, expected struct KeysInput";
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (p256dh === undefined) return "missing field `p256dh`";
  if (auth === undefined) return "missing field `auth`";
  if (typeof p256dh !== "string" || typeof auth !== "string") return "invalid type, expected a string";
  return { endpoint, keys: { p256dh, auth } };
}

export async function subscribe(services: Services, caller: Caller, body: string): Promise<Response> {
  const id = device(caller);
  if (id instanceof Response) return id;
  const input = subscriptionInput(body);
  if (typeof input === "string") return badArguments(input);
  let created;
  try {
    created = await parseSubscription(input);
  } catch (error) {
    if (error instanceof PushInputError) return failed(invalidInput(error.message));
    throw error;
  }
  const refused = await services.push.admit(created.endpoint);
  if (refused !== null) return failed(invalidInput(refused));
  return answer(() => subscriptionView(savePushSubscription(services.storage.db, id, created, services.storage.now())));
}

export function unsubscribe(services: Services, caller: Caller): Response {
  const id = device(caller);
  if (id instanceof Response) return id;
  return answer(() => {
    deletePushSubscription(services.storage.db, id);
    return null;
  });
}

const SETTINGS_FIELDS = ["completion", "messages", "important", "started", "finished"] as const;

/** The settings a request sets: `completion` and `messages` always, the rest when given. */
type SettingsInput = Pick<PushSettings, "completion" | "messages"> & Partial<PushSettings>;

/** `{ completion, messages?, important?, started?, finished? }` as serde reads it, with
 * unknown fields refused. A web app from before agent messages leaves `messages` out, and
 * they stay on for it; one from before the chat and task settings were split leaves the
 * newer fields out, and they keep their saved values. */
function settingsInput(body: string): SettingsInput | string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "invalid type, expected struct SettingsView";
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) {
      return `unknown field \`${key}\`, expected one of ${SETTINGS_FIELDS.map((field) => `\`${field}\``).join(", ")}`;
    }
  }
  const { completion, messages = true, important, started, finished } = fields;
  if (completion === undefined) return "missing field `completion`";
  const given = { completion, messages, important, started, finished };
  const input: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(given)) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") return "invalid type, expected a boolean";
    input[key] = value;
  }
  return input as SettingsInput;
}

export function saveSettings(services: Services, caller: Caller, body: string): Response {
  const id = device(caller);
  if (id instanceof Response) return id;
  const settings = settingsInput(body);
  if (typeof settings === "string") return badArguments(settings);
  return answer(() => {
    const saved = pushSubscription(services.storage.db, id)?.settings ?? DEFAULT_PUSH_SETTINGS;
    return subscriptionView(setPushSettings(services.storage.db, id, { ...saved, ...settings }));
  });
}

export async function test(services: Services, caller: Caller): Promise<Response> {
  const id = device(caller);
  if (id instanceof Response) return id;
  try {
    await sendTest(services.storage.db, services.push, id);
    return json(200, null);
  } catch (error) {
    if (error instanceof PushTestError) {
      return failed(error.kind === "not_found" ? notFound(error.message) : new CommandError("external", error.message));
    }
    return failed(commandError(error));
  }
}

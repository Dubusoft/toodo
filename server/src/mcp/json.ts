// JSON the way the Rust server writes what passes through a `serde_json::Value` first: its
// objects are `BTreeMap`s there, so their keys come out sorted.

import { rustJsonPretty } from "../commands/review.ts";

/** `value` with the keys of every object in it sorted by their bytes. */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => {
    const [x, y] = [Buffer.from(a), Buffer.from(b)];
    return Buffer.compare(x, y);
  });
  return Object.fromEntries(entries.map(([key, item]) => [key, sortedKeys(item)]));
}

/** `value` as `serde_json::to_string_pretty` writes it after `serde_json::to_value`. */
export function sortedPrettyJson(value: unknown): string {
  return rustJsonPretty(sortedKeys(value));
}

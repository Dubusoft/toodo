// The Dori config on the Settings page: `GET /api/dori/config` shows the keys of the host's
// config.json and `PUT /api/dori/config` changes one, through the store the host hands over
// (`DoriConfigStore`, implemented by Dori). The supervisor applies a saved change itself.

import type { DoriConfigEdit, DoriConfigStore } from "../../../src/lib/dori-config.ts";
import { json, text } from "./auth.ts";

export class DoriConfigRoutes {
  readonly #store: DoriConfigStore;
  // Saves run one at a time: each reads the file the previous one wrote.
  #saving: Promise<unknown> = Promise.resolve();

  constructor(store: DoriConfigStore) {
    this.#store = store;
  }

  get(): Response {
    return json(200, this.#store.view());
  }

  put(body: string): Promise<Response> {
    const saved = this.#saving.then(() => this.#save(body));
    this.#saving = saved.catch(() => undefined);
    return saved;
  }

  async #save(body: string): Promise<Response> {
    let edit: DoriConfigEdit;
    try {
      const parsed = JSON.parse(body) as Partial<Record<keyof DoriConfigEdit, unknown>> | null;
      if (typeof parsed?.key !== "string" || typeof parsed.value !== "string") throw new Error();
      edit = { key: parsed.key, value: parsed.value };
    } catch {
      return text(400, 'the body must be {"key": "<config key>", "value": "<text>"}');
    }
    const result = await this.#store.save(edit);
    return "status" in result ? text(result.status, result.message) : json(200, result);
  }
}

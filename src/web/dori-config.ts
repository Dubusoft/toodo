/**
 * The web app's client of `/api/dori/config`: the Dori config of the server's host, and one
 * key's change. A refused change throws with the reason the server gave.
 */
import type { DoriConfigEdit, DoriConfigSaved, DoriConfigView } from "@/lib/dori-config";
import { apiRequest } from "@/web/session";

export async function fetchDoriConfig(): Promise<DoriConfigView> {
  return (await (await apiRequest("/api/dori/config")).json()) as DoriConfigView;
}

export async function saveDoriConfig(edit: DoriConfigEdit): Promise<DoriConfigSaved> {
  const response = await apiRequest("/api/dori/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(edit),
  });
  return (await response.json()) as DoriConfigSaved;
}

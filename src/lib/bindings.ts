// The web app's client of the Toodo API (`api.ts`): its commands over `/api/rpc` and its
// events over the server's event stream, with every type of the API.

import { invoke } from "@/web/core";
import { listen } from "@/web/event";
import { makeCommands, makeEvents } from "./api";

export type * from "./api";

export const commands = makeCommands(invoke);

export const events = makeEvents(listen);

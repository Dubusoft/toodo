// The English UI catalog, the one every other locale falls back to (see `src/lib/i18n.tsx`).
// Each area is its own module; a message with values is a function of them.
import { common } from "@/locales/en/common";
import { app } from "@/locales/en/app";
import { tasks } from "@/locales/en/tasks";
import { details } from "@/locales/en/details";
import { chat } from "@/locales/en/chat";
import { settings } from "@/locales/en/settings";
import { review } from "@/locales/en/review";

export const en = { common, app, tasks, details, chat, settings, review };

export type Messages = typeof en;

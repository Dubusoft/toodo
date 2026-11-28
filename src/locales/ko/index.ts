// The Korean UI catalog. Keys it leaves out show in English (see `src/lib/i18n.tsx`).
import type { Catalog } from "@/lib/i18n";
import { common } from "@/locales/ko/common";
import { app } from "@/locales/ko/app";
import { tasks } from "@/locales/ko/tasks";
import { details } from "@/locales/ko/details";
import { chat } from "@/locales/ko/chat";
import { settings } from "@/locales/ko/settings";
import { review } from "@/locales/ko/review";
import { alerts } from "@/locales/ko/alerts";

export const ko: Catalog = { common, app, tasks, details, chat, settings, review, alerts };

/** How the language setting may name Korean in Korean. */
export const nativeNames = ["한국어", "한국말"];

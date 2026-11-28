// The language of the web app's screens, kept in `settings` so every device shows the same.

import type { Database } from "bun:sqlite";
import type { AppLanguage } from "../../../src/lib/api.ts";

const APP_LANGUAGE = "app_language";

/** The language set for the web app's screens, or `null` while none is set. */
export function appLanguage(db: Database): AppLanguage | null {
  const value = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?1")
    .get(APP_LANGUAGE)?.value;
  return value === "en" || value === "ko" ? value : null;
}

/** Sets the language of the web app's screens; `null` unsets it. */
export function setAppLanguage(db: Database, language: AppLanguage | null): AppLanguage | null {
  if (language === null) {
    db.run("DELETE FROM settings WHERE key = ?1", [APP_LANGUAGE]);
  } else {
    db.run(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [APP_LANGUAGE, language],
    );
  }
  return language;
}

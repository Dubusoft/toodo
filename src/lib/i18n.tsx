// The web app's UI language. The language setting (Dori's `ownerLanguage`, see
// `src/lib/dori-config.ts`) picks it: Korean shows the Korean catalog, any other language or
// none shows English. The catalogs live in `src/locales/<locale>/`, one module per area; a
// key the Korean catalog lacks shows its English text.
import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { en, type Messages } from "@/locales/en";
import { ko, nativeNames as koNames } from "@/locales/ko";
import { DORI_LANGUAGE_KEY, DORI_TIME_ZONE_KEY } from "@/lib/dori-config";
import { setDisplayTimeZone } from "@/lib/timeline";
import { fetchDoriConfig } from "@/web/dori-config";

export type Locale = "en" | "ko";

/** A partial catalog: each area may leave out keys, which then show in English. */
export type Catalog = { readonly [Area in keyof Messages]?: Partial<Messages[Area]> };

const catalogs: Record<Locale, Catalog> = { en, ko };

/** The locale a language setting names: Korean by its English or native name or code, else English. */
export function localeOf(language: string | null | undefined): Locale {
  const name = (language ?? "").trim().toLowerCase();
  if (/^ko\b|korean/.test(name) || koNames.some((native) => name.startsWith(native))) return "ko";
  return "en";
}

/** The messages of `locale`, each missing key filled with its English text. */
export function messagesFor(locale: Locale): Messages {
  const catalog = catalogs[locale];
  if (catalog === en) return en;
  const merged = {} as Record<keyof Messages, unknown>;
  for (const area of Object.keys(en) as (keyof Messages)[]) merged[area] = { ...en[area], ...catalog[area] };
  return merged as Messages;
}

/**
 * A message with elements in it: each `{name}` in `text` is replaced by `values[name]`, so a
 * catalog keeps whole sentences, and a language orders their parts as it needs.
 */
export function fill(text: string, values: Readonly<Record<string, ReactNode>>): ReactNode {
  return text.split(/\{(\w+)\}/).map((part, index) => (
    <Fragment key={index}>{index % 2 === 1 ? (values[part] ?? `{${part}}`) : part}</Fragment>
  ));
}

const STORAGE_KEY = "toodo-locale";

function storedLocale(): Locale {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ko" ? "ko" : "en";
  } catch {
    return "en";
  }
}

/** The messages of the UI language, for text built outside React, such as browser notifications. */
export function currentMessages(): Messages {
  return messagesFor(storedLocale());
}

type I18n = {
  locale: Locale;
  messages: Messages;
  /** The Time zone setting, so that a change shows every date again in it; null is this device's. */
  timeZone: string | null;
  setLocale: (locale: Locale) => void;
  setTimeZone: (zone: string | null) => void;
};

// Without a provider (as in component tests) the app is in English, in this device's time zone.
const I18nContext = createContext<I18n>({ locale: "en", messages: en, timeZone: null, setLocale: () => {}, setTimeZone: () => {} });

/**
 * Holds the UI language. It starts with the one this browser last used, so a reload does not
 * flash English, until the language setting is read (`useLocaleFromSettings`).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(storedLocale);
  const [timeZone, setTimeZoneState] = useState<string | null>(null);
  const value = useMemo<I18n>(
    () => ({
      locale,
      messages: messagesFor(locale),
      timeZone,
      setTimeZone: (zone) => {
        setDisplayTimeZone(zone);
        setTimeZoneState(zone);
      },
      setLocale: (next) => {
        setLocaleState(next);
        try {
          localStorage.setItem(STORAGE_KEY, next);
        } catch {
          // Private mode without storage: the language still applies until the next reload.
        }
      },
    }),
    [locale, timeZone],
  );
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The shown messages, and the locale for dates and numbers (`Intl`, `toLocaleString`). */
export function useI18n(): { locale: Locale; m: Messages } {
  const { locale, messages } = useContext(I18nContext);
  return { locale, m: messages };
}

export function useMessages(): Messages {
  return useContext(I18nContext).messages;
}

/** The query of the Dori config, shared with the Settings page that edits it. */
export const doriConfigKey = ["dori-config"];

/**
 * Follows the language and time zone settings: reads them once signed in and again whenever the
 * Settings page saves or refetches them. A server without Dori has neither, so the language stays
 * as it is and dates stay in this device's time zone.
 */
export function useLocaleFromSettings(): void {
  const { setLocale, setTimeZone } = useContext(I18nContext);
  const config = useQuery({ queryKey: doriConfigKey, queryFn: fetchDoriConfig, retry: false, staleTime: Infinity });
  const language = config.data?.entries.find((entry) => entry.key === DORI_LANGUAGE_KEY)?.value;
  const timeZone = config.data?.entries.find((entry) => entry.key === DORI_TIME_ZONE_KEY)?.value;
  useEffect(() => {
    if (language !== undefined) setLocale(localeOf(language));
  }, [language]);
  useEffect(() => {
    if (timeZone !== undefined) setTimeZone(timeZone || null);
  }, [timeZone]);
}

// The Dori config the Settings page shows and edits (`GET` and `PUT /api/dori/config`): the
// keys of the host's `~/.dori/config.json` that Dori reads. Both the server and the web app
// import this file, so it holds types and constants only.

/** How a key's value is written: `list` as comma separated text, `json` as JSON. */
export type DoriConfigKind = "string" | "list" | "json" | "enum" | "bool";

/**
 * `edit`: changed from the web app. `readOnly`: shown only; its value is a command the host
 * runs or where Dori keeps its state, so it is changed on the host. `masked`: read-only and
 * shown by its entry names alone.
 */
export type DoriConfigAccess = "edit" | "readOnly" | "masked";

export type DoriConfigEntry = {
  readonly key: string;
  readonly kind: DoriConfigKind;
  readonly describe: string;
  /** The values an `enum` key takes; `null` for the other kinds. */
  readonly values: readonly string[] | null;
  readonly required: boolean;
  /** The value as text (a list of strings comma joined, other non-strings JSON); "" when unset. */
  readonly value: string;
  readonly access: DoriConfigAccess;
  /** The running supervisor takes a change of this key only after a restart. */
  readonly restart: boolean;
};

export type DoriConfigView = {
  /** The config file on the host. */
  readonly path: string;
  /** Whether the file exists; without it nothing can be saved (run `dori setup` first). */
  readonly present: boolean;
  /** Why the file cannot be read, while it cannot. */
  readonly error: string | null;
  readonly entries: readonly DoriConfigEntry[];
};

/** `PUT /api/dori/config`: one key's new value as text, "" to unset it. */
export type DoriConfigEdit = { readonly key: string; readonly value: string };

export type DoriConfigSaved = {
  readonly view: DoriConfigView;
  /** The change waits for a supervisor restart; any other change applies at once. */
  readonly restart: boolean;
};

/** A save Dori refused, with the HTTP status the route answers. */
export type DoriConfigRefusal = { readonly status: 400 | 403 | 409; readonly message: string };

/**
 * Dori's config file as the core serves it. Dori implements it
 * (`dori/skills/dori-mode/scripts/src/config-edit.ts`) and the host hands it to the core, so
 * the core runs no Dori code of its own.
 */
export type DoriConfigStore = {
  readonly view: () => DoriConfigView;
  readonly save: (edit: DoriConfigEdit) => Promise<DoriConfigSaved | DoriConfigRefusal>;
};

/** The key the Language setting edits: the language Dori writes to its owner in. */
export const DORI_LANGUAGE_KEY = "ownerLanguage";

/** The key the Time zone setting edits: the IANA time zone the app and Dori show times in. */
export const DORI_TIME_ZONE_KEY = "displayTimeZone";

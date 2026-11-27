// Two servers given the same database and the same calls answer the same, except for what
// depends on the moment or the process: clock readings, the instance id, the epoch of event
// ids, and the paths and ports of their data directories. Normalizing replaces exactly those
// with placeholders, so every other difference is a real one.

export type Normalizer = {
  /** Unix seconds: readings of the clock taken during the run fall in this window. */
  from: number;
  to: number;
  /** Literal text to replace, such as each server's data directory, URL, and tokens. */
  replacements: Array<[string, string]>;
};

/** Fields that name the server process rather than the data. */
const processKeys = new Set(["instance"]);

/** `{ name: "toodo", version }` names the server's build (`app_info`, MCP `serverInfo`), which differs between a release and a checkout. */
const namesBuild = (value: object): boolean =>
  "name" in value && value.name === "toodo" && "version" in value && typeof value.version === "string";

const isoTime = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g;

export function inWindow(n: Normalizer, value: number): "s" | "ms" | null {
  if (!Number.isInteger(value)) return null;
  if (value >= n.from - 2 && value <= n.to + 2) return "s";
  if (value >= (n.from - 2) * 1000 && value <= (n.to + 2) * 1000) return "ms";
  return null;
}

export function normalizeText(n: Normalizer, text: string): string {
  let out = text;
  for (const [literal, placeholder] of n.replacements) out = out.split(literal).join(placeholder);
  out = out.replace(/server instance [0-9a-f]+/g, "server instance <instance>");
  out = out.replace(isoTime, (match) => {
    const ms = Date.parse(match);
    return Number.isNaN(ms) || inWindow(n, Math.floor(ms / 1000)) === null ? match : "<now-iso>";
  });
  // File names stamp the UTC time as YYYYMMDD-HHMMSS, e.g. toodo-auto-20261127-055548.sqlite3.
  out = out.replace(/\b(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\b/g, (match, y, mo, d, h, mi, s) => {
    const seconds = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000;
    return inWindow(n, seconds) === "s" ? "<now-stamp>" : match;
  });
  // 128 random bits in hex name stored files (chat attachments); every server draws its own.
  out = out.replace(/\b[0-9a-f]{32}\b/g, "<random>");
  out = out.replace(/\b\d{10}(?:\d{3})?\b/g, (match) => {
    const unit = inWindow(n, Number(match));
    return unit === null ? match : unit === "s" ? "<now>" : "<now-ms>";
  });
  return out;
}

export function normalizeValue(n: Normalizer, value: unknown): unknown {
  if (typeof value === "number") {
    const unit = inWindow(n, value);
    return unit === null ? value : unit === "s" ? "<now>" : "<now-ms>";
  }
  if (typeof value === "string") return normalizeText(n, value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(n, item));
  if (value !== null && typeof value === "object") {
    const build = namesBuild(value);
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        build && key === "version" ? "<version>" : processKeys.has(key) && typeof item === "string" ? "<instance>" : normalizeValue(n, item),
      ]),
    );
  }
  return value;
}

/** An event id is `<epoch>-<sequence>`; the epoch changes with every server start. */
export function normalizeEventId(id: string | null): string | null {
  return id === null ? null : id.replace(/^[^-]+-/, "<epoch>-");
}

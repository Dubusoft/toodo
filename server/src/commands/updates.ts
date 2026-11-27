// Whether a newer Toodo is published on npm: the web app shows it in its settings.

import { STATUS_CODES } from "node:http";

import type { Reply } from "./types.ts";

/** The npm package Toodo is published as. */
export const PACKAGE = "@dubusoft/toodo";
/** The registry the server asks, unless `TOODO_NPM_REGISTRY` names another one. */
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const TIMEOUT_MS = 10_000;

type UpdateCheck = Reply<"checkUpdate">;

/** The npm dist-tag an installed `version` follows: prereleases come from `dev`. */
export function channelOf(version: string): "dev" | "latest" {
  return version.includes("-") ? "dev" : "latest";
}

const NUMBER = "(0|[1-9]\\d*)";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

interface Version {
  core: [bigint, bigint, bigint];
  pre: string[];
}

function parseVersion(version: string): Version | null {
  const match = SEMVER.exec(version);
  if (match === null) return null;
  const [, major, minor, patch, pre] = match;
  return {
    core: [BigInt(major as string), BigInt(minor as string), BigInt(patch as string)],
    pre: pre === undefined ? [] : pre.split("."),
  };
}

function sign(a: bigint | string, b: bigint | string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Prerelease precedence: a release outranks its prereleases, whose identifiers compare in
 * order, numbers by value and below words. */
function comparePre(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return sign(BigInt(b.length), BigInt(a.length));
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i] as string;
    const y = b[i] as string;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    const order = xNumeric && yNumeric
      ? sign(BigInt(x), BigInt(y))
      : xNumeric !== yNumeric ? (xNumeric ? -1 : 1) : sign(x, y);
    if (order !== 0) return order;
  }
  return sign(BigInt(a.length), BigInt(b.length));
}

/** How `version` compares with `installed` by semver precedence (build metadata is
 * ignored): negative, zero, or positive, or `null` when either is not a semver version. */
export function compareVersions(version: string, installed: string): number | null {
  const a = parseVersion(version);
  const b = parseVersion(installed);
  if (a === null || b === null) return null;
  for (let i = 0; i < 3; i += 1) {
    const order = sign(a.core[i] as bigint, b.core[i] as bigint);
    if (order !== 0) return order;
  }
  return comparePre(a.pre, b.pre);
}

/** The check of `current` against the registry's dist-tags document of `PACKAGE`, e.g.
 * `{"latest":"1.3.2","dev":"1.3.3-dev.70"}`. */
export function fromDistTags(current: string, tags: unknown): UpdateCheck {
  const channel = channelOf(current);
  const tag = typeof tags === "object" && tags !== null ? (tags as Record<string, unknown>)[channel] : undefined;
  const latest = typeof tag === "string" ? tag : null;
  return {
    current,
    channel,
    latest,
    newer: latest !== null && (compareVersions(latest, current) ?? 0) > 0,
    error: latest === null
      ? `npm has no ${channel} version of ${PACKAGE}; check for updates on the server with: toodo update --check`
      : null,
  };
}

async function distTags(registry: string): Promise<unknown> {
  const url = new URL(`${registry.replace(/\/+$/, "")}/-/package/${PACKAGE}/dist-tags`).href;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" });
  } catch {
    throw new Error(`error sending request for url (${url})`);
  }
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status} ${STATUS_CODES[response.status] ?? "<unknown status code>"}`);
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    throw new Error(`request or response body error for url (${url})`);
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`GET ${url} sent no JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Asks the npm registry (`TOODO_NPM_REGISTRY`, else the public one) for the newest version
 * on the channel of `current`, the version the server runs. */
export async function checkUpdate(
  current: string,
  registry = process.env.TOODO_NPM_REGISTRY || DEFAULT_REGISTRY,
): Promise<UpdateCheck> {
  try {
    return fromDistTags(current, await distTags(registry));
  } catch (cause) {
    return {
      current,
      channel: channelOf(current),
      latest: null,
      newer: false,
      error: `cannot reach the npm registry ${registry}: ${cause instanceof Error ? cause.message : String(cause)}; check the server's network, or check for updates on the server with: toodo update --check`,
    };
  }
}

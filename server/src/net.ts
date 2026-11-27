// Outbound HTTP to addresses that come from outside the server (push service endpoints,
// URL criteria, later client metadata documents) reaches only the public internet, never
// the server itself or its private network. Port of `src-tauri/src/net.rs`.

import { lookup } from "node:dns/promises";
import { STATUS_CODES } from "node:http";
import { isIPv4, isIPv6 } from "node:net";

/** The IP address a URL names as its host, if it names one rather than a host name. The
 * WHATWG parser has already turned forms such as `2130706433` into dotted IPv4. */
export function literalIp(url: URL): string | null {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return isIPv4(host) || isIPv6(host) ? host : null;
}

function ipv4Octets(ip: string): number[] {
  return ip.split(".").map(Number);
}

/** The eight 16-bit groups of an IPv6 address, an embedded dotted IPv4 tail included. */
function ipv6Segments(ip: string): number[] {
  let text = ip.toLowerCase();
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted !== null) {
    const [a, b, c, d] = ipv4Octets(dotted[1]!);
    text = `${text.slice(0, -dotted[1]!.length)}${((a! << 8) | b!).toString(16)}:${((c! << 8) | d!).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, null];
  const parse = (part: string | undefined | null) =>
    part === undefined || part === null || part === "" ? [] : part.split(":").map((group) => parseInt(group, 16));
  const front = parse(head);
  if (tail === null) return front;
  const back = parse(tail);
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back];
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  return !(
    a === 10 ||
    (a === 172 && (b! & 0xf0) === 16) ||
    (a === 192 && b === 168) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a === 0 ||
    (a === 255 && b === 255 && c === 255) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a! & 0xf0) === 224 ||
    (a === 100 && (b! & 0xc0) === 64)
  );
}

/** Whether `ip` is reachable on the public internet, not loopback, private, link-local,
 * shared (CGNAT), or otherwise reserved. `ip` is an IPv4 or IPv6 address. */
export function isPublic(ip: string): boolean {
  if (isIPv4(ip)) return isPublicIpv4(ipv4Octets(ip));
  const segments = ipv6Segments(ip);
  const first = segments[0]!;
  if (segments.slice(0, 5).every((segment) => segment === 0) && segments[5] === 0xffff) {
    const [high, low] = [segments[6]!, segments[7]!];
    return isPublicIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  const zeroUntilLast = segments.slice(0, 7).every((segment) => segment === 0);
  return !(
    (zeroUntilLast && (segments[7] === 0 || segments[7] === 1)) ||
    (first & 0xff00) === 0xff00 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80
  );
}

/** The public addresses `host` resolves to; throws when it has none. */
export async function publicAddresses(host: string): Promise<string[]> {
  const addresses = (await lookup(host, { all: true }))
    .map((entry) => entry.address)
    .filter(isPublic);
  if (addresses.length === 0) throw new Error(`${host} has no public address`);
  return addresses;
}

/** Why a GET of a URL from outside the server failed, worded as the Rust server words it. */
export class OutboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundError";
  }
}

/** A GET that answered: its status as `200 OK`, the way the Rust server prints a status. */
export type OutboundResponse = { readonly ok: boolean; readonly status: string };

/** Sends a GET to a URL; a redirect is returned as the response, not followed. */
export type Outbound = (url: string) => Promise<OutboundResponse>;

function statusLine(status: number): string {
  return `${status} ${STATUS_CODES[status] ?? "<unknown status code>"}`;
}

/** A GET that reaches only public addresses (`anyAddress` also reaches loopback and private
 * ones, for tests against a local server), without following redirects, and gives up after
 * `timeoutMs`. Unlike the Rust client, which connects only to the public addresses a name
 * resolves to, it refuses a name that resolves to any address that is not public, since
 * fetch cannot be told which address to connect to. */
export function outbound(timeoutMs: number, anyAddress = false): Outbound {
  return async (target) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new OutboundError(`builder error for url (${target})`);
    }
    const unreachable = () => new OutboundError(`error sending request for url (${url.href})`);
    if (!anyAddress) {
      const literal = literalIp(url);
      if (literal !== null) {
        if (!isPublic(literal)) throw new OutboundError("the URL names an address that is not public");
      } else {
        const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
        if (addresses.length === 0 || !addresses.every(({ address }) => isPublic(address))) throw unreachable();
      }
    }
    let response: Response;
    try {
      response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw unreachable();
    }
    await response.body?.cancel();
    return { ok: response.status >= 200 && response.status < 300, status: statusLine(response.status) };
  };
}

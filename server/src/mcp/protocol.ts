// The MCP endpoint behind the token guard, as the Rust server's `rmcp` streamable HTTP service
// answers it (`StreamableHttpService` in stateless mode with JSON responses, which
// `src-tauri/src/mcp/mod.rs` configures): one JSON-RPC message per POST, answered with one
// JSON response, or a server-sent event stream for `subscriptions/listen`. Clients either
// `initialize` (protocol versions up to 2025-11-25) or name the 2026-07-28 protocol in each
// request's `_meta` with matching `MCP-Protocol-Version`, `Mcp-Method`, and `Mcp-Name`
// headers. Status codes, messages, and the order of the checks are those of `rmcp` 3.11.

import type * as B from "../../../src/lib/api.ts";
import { CommandError, commandError, panicked } from "../commands/errors.ts";
import type { Notifier } from "../commands/events.ts";
import { VERSION } from "../http/version.ts";
import type { Grant } from "../storage/oauth.ts";
import type { Storage } from "../storage/storage.ts";
import { canWrite, type Scopes } from "../oauth/scopes.ts";
import { ArgumentError, numbersFromStrings } from "./args.ts";
import { CHAT_INSTRUCTIONS, INSTRUCTIONS } from "./instructions.ts";
import { rustJsonPretty } from "../commands/review.ts";
import { sortedKeys } from "./json.ts";
import * as resources from "./resources.ts";
import TOOL_LIST from "./tools.json" with { type: "json" };
import { TOOLS, Text } from "./tools/index.ts";

/** What the endpoint serves from, and where it announces what the tools change. */
export interface Backend extends Notifier {
  /** The writer connection. */
  readonly storage: Storage;
  /** The read-only connection. */
  readonly reader: Storage;
  /** How agents reach the server; its `instance` tells this server apart from others. */
  readonly mcp: B.McpServerInfo;
  /** The public origin of public mode, where chat apps connect over OAuth. */
  readonly publicUrl?: string | null;
  /** Calls `listener` on every change announced to clients, until the returned function is
   * called. */
  onChange(listener: () => void): () => void;
}

/** How a request reached `/mcp`: with the MCP token, or as a chat app over OAuth. */
export type Access = { readonly kind: "static" } | { readonly kind: "oauth"; readonly grant: Grant };

const READ_TOOLS = new Set([
  "read_toodo_skill",
  "list_workspaces",
  "list_tasks",
  "search_tasks",
  "get_task",
  "get_guidelines",
  "review_report",
]);
const WRITE_TOOLS = new Set([
  "create_workspace",
  "create_task",
  "create_plan",
  "update_task",
  "move_task",
  "add_dependency",
  "remove_dependency",
  "add_related",
  "remove_related",
  "add_criterion",
  "remove_criterion",
  "check_criterion",
  "add_progress_note",
  "report_blocker",
  "pause_task",
  "wait_task",
  "add_guideline",
  "update_guideline",
  "remove_guideline",
]);

/** Why a chat app whose grant has `scopes` may not call tool `name`, or `null` when it may.
 * The tools that start, finish, or delete work stay with local agents. */
export function oauthRefusal(name: string, scopes: Scopes): string | null {
  if (READ_TOOLS.has(name)) return null;
  if (!WRITE_TOOLS.has(name)) {
    return `${name} is local-only; use the Toodo app or a local agent with the MCP token.`;
  }
  return canWrite(scopes) ? null : `${name} requires toodo.write; reconnect from the app and approve that scope.`;
}

/** The protocol versions this server knows, oldest first. */
export const KNOWN_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];
/** The first version that replaced `initialize` with per-request `_meta` and requires the
 * standard headers. */
const NO_INITIALIZE = "2026-07-28";
/** The newest version an `initialize` handshake agrees to. */
const LATEST_WITH_INITIALIZE = "2025-11-25";
/** The version of a request that names none. */
const DEFAULT_VERSION = "2025-03-26";

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** How big a request body may be. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** How often a listen stream sends a comment to keep the connection open. */
const KEEP_ALIVE_MS = 15_000;

const ErrorCode = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  resourceNotFound: -32002,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const;

type RequestId = number | string;
type JsonObject = Record<string, unknown>;
type ErrorData = { code: number; message: string; data?: unknown };

type Message =
  | { kind: "request"; id: RequestId; method: string; params: unknown }
  | { kind: "notification"; method: string }
  | { kind: "response" };

const JSON_TYPE = "application/json";
const EVENT_STREAM = "text/event-stream";

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_TYPE } });
}

function errorResponse(status: number, id: RequestId | null, error: ErrorData): Response {
  return json(status, id === null ? { jsonrpc: "2.0", error } : { jsonrpc: "2.0", id, error });
}

class Rejected {
  constructor(readonly response: Response) {}
}

/** The media types `Accept` lists, without those whose weight is zero. */
function acceptedTypes(headers: Headers): string[] {
  const value = headers.get("accept");
  if (value === null) return [];
  const split = (input: string, delimiter: string) => {
    const parts: string[] = [];
    let quoted = false;
    let escaped = false;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (escaped) escaped = false;
      else if (quoted && char === "\\") escaped = true;
      else if (char === '"') quoted = !quoted;
      else if (!quoted && char === delimiter) {
        parts.push(input.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(input.slice(start));
    return parts;
  };
  const acceptable = (quality: string) => {
    const [whole, fraction = ""] = quality.split(/\.(.*)/s);
    if (fraction.length > 3 || !/^[0-9]*$/.test(fraction)) return true;
    return whole !== "0" || /[1-9]/.test(fraction);
  };
  return split(value, ",").flatMap((entry) => {
    const [essence, ...parameters] = split(entry, ";");
    const keep = parameters.every((parameter) => {
      const equals = parameter.indexOf("=");
      if (equals < 0) return true;
      return parameter.slice(0, equals).trim().toLowerCase() !== "q" || acceptable(parameter.slice(equals + 1).trim());
    });
    return keep ? [essence.trim()] : [];
  });
}

/** Host and port of an authority such as `127.0.0.1:47616` or `[::1]:8080`, lowercased and
 * without brackets; `null` when it is not an authority. */
function authority(value: string): { host: string; port: number | null } | null {
  const match = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#[\]@]*)(?::([0-9]*))?$/.exec(value);
  if (match === null || match[1] === "") return null;
  const port = match[2] === undefined || match[2] === "" ? null : Number(match[2]);
  if (port !== null && port > 65535) return null;
  return { host: match[1].replace(/^\[|\]$/g, "").toLowerCase(), port };
}

/** Turns away a request whose `Host` this server does not answer to, against DNS rebinding. */
function checkHost(request: Request, allowedHosts: readonly string[]): void {
  const header = request.headers.get("host") ?? new URL(request.url).host;
  const host = authority(header);
  if (host === null) {
    throw new Rejected(text(400, "Bad Request: Invalid Host header", { "content-type": "text/plain; charset=utf-8" }));
  }
  const allowed = allowedHosts.some((entry) => {
    const parsed = authority(entry.trim()) ?? { host: entry.trim().toLowerCase(), port: null };
    return parsed.host === host.host && (parsed.port === null || parsed.port === host.port);
  });
  if (!allowed) throw new Rejected(text(403, "Forbidden: Host header is not allowed"));
}

/** Where JSON text stops being valid, as `serde_json` reports it. */
export function jsonSyntaxError(source: string): string | null {
  let i = 0;
  const fail = (message: string, at = i): never => {
    const before = source.slice(0, at);
    const line = before.split("\n").length;
    const column = at - (before.lastIndexOf("\n") + 1) + (at < source.length ? 1 : 0);
    throw new Error(`${message} at line ${line} column ${column}`);
  };
  const space = () => {
    while (i < source.length && " \t\n\r".includes(source[i])) i++;
  };
  const string = () => {
    i++;
    for (;;) {
      if (i >= source.length) fail("EOF while parsing a string");
      const char = source[i];
      if (char === '"') {
        i++;
        return;
      }
      if (char.charCodeAt(0) < 0x20) fail("control character (\\u0000-\\u001F) found while parsing a string");
      if (char === "\\") {
        i++;
        if (i >= source.length) fail("EOF while parsing a string");
        const escape = source[i];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(i + 1, i + 5))) fail("invalid escape");
          i += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) fail("invalid escape");
      }
      i++;
    }
  };
  const value = (): void => {
    space();
    if (i >= source.length) fail("EOF while parsing a value");
    const char = source[i];
    if (char === "{") {
      i++;
      space();
      if (source[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        space();
        if (i >= source.length) fail("EOF while parsing an object");
        if (source[i] !== '"') fail("key must be a string");
        string();
        space();
        if (i >= source.length) fail("EOF while parsing an object");
        if (source[i] !== ":") fail("expected `:`");
        i++;
        value();
        space();
        if (i >= source.length) fail("EOF while parsing an object");
        if (source[i] === "}") {
          i++;
          return;
        }
        if (source[i] !== ",") fail("expected `,` or `}`");
        i++;
        space();
        if (source[i] === "}") fail("trailing comma");
      }
    }
    if (char === "[") {
      i++;
      space();
      if (source[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        value();
        space();
        if (i >= source.length) fail("EOF while parsing a list");
        if (source[i] === "]") {
          i++;
          return;
        }
        if (source[i] !== ",") fail("expected `,` or `]`");
        i++;
        space();
        if (source[i] === "]") fail("trailing comma");
      }
    }
    if (char === '"') return string();
    for (const word of ["true", "false", "null"]) {
      if (char === word[0]) {
        for (let k = 0; k < word.length; k++, i++) {
          if (i >= source.length) fail("EOF while parsing a value");
          if (source[i] !== word[k]) fail("expected ident");
        }
        return;
      }
    }
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
    if (char === "-" || (char >= "0" && char <= "9")) {
      if (number === null || number[0] === "-") fail("invalid number", i + 1);
      i += (number as RegExpExecArray)[0].length;
      return;
    }
    fail("expected value");
  };
  try {
    value();
    space();
    if (i < source.length) fail("trailing characters");
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** The message a body holds, or the `415` that tells why it holds none. */
function parseMessage(body: string): Message {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    const reason = jsonSyntaxError(body) ?? "expected value at line 1 column 1";
    throw new Rejected(text(415, `fail to deserialize request body ${reason}`));
  }
  const unrecognized = () => new Rejected(text(415, "fail to deserialize request body unrecognized JSON-RPC message"));
  if (!isObject(value) || value.jsonrpc !== "2.0") throw unrecognized();
  const id = value.id;
  const validId = typeof id === "string" || (typeof id === "number" && Number.isInteger(id));
  if (typeof value.method === "string") {
    if ("id" in value) {
      if (!validId) throw unrecognized();
      return { kind: "request", id: id as RequestId, method: value.method, params: value.params };
    }
    return { kind: "notification", method: value.method };
  }
  if (validId && ("result" in value || "error" in value)) return { kind: "response" };
  throw unrecognized();
}

/** The `_meta` of a request's params. */
function metaOf(params: unknown): JsonObject {
  return isObject(params) && isObject(params._meta) ? params._meta : {};
}

function metaVersion(meta: JsonObject): string | null {
  const version = meta[META_PROTOCOL_VERSION];
  return typeof version === "string" ? version : null;
}

/** The `_meta` keys the 2026-07-28 lifecycle requires that `meta` lacks. */
function missingMetaKeys(meta: JsonObject): string[] {
  const missing: string[] = [];
  if (metaVersion(meta) === null) missing.push(META_PROTOCOL_VERSION);
  if (!isObject(meta[META_CLIENT_CAPABILITIES])) missing.push(META_CLIENT_CAPABILITIES);
  return missing;
}

/** The `Mcp-Name` value a request must carry, if its method has one. */
function nameOf(method: string, params: unknown): string | null {
  if (!isObject(params)) return null;
  const key = ["tools/call", "prompts/get"].includes(method)
    ? "name"
    : ["resources/read", "resources/subscribe", "resources/unsubscribe"].includes(method)
      ? "uri"
      : ["tasks/get", "tasks/update", "tasks/cancel"].includes(method)
        ? "taskId"
        : null;
  const value = key === null ? undefined : params[key];
  return typeof value === "string" ? value : null;
}

/** A header value with the `=?base64?...?=` wrapping undone; `null` when it wraps invalid
 * Base64. */
function decodeHeader(value: string): string | null {
  const match = /^=\?base64\?(.*)\?=$/s.exec(value);
  if (match === null) return value;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(match[1]) || match[1].length % 4 !== 0) return null;
  const decoded = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoded.decode(Buffer.from(match[1], "base64"));
  } catch {
    return null;
  }
}

/** The protocol version header, which must name a known version unless the request names
 * its own version in `_meta`. */
function checkVersionHeader(headers: Headers, allowUnknown: boolean): void {
  const version = headers.get("mcp-protocol-version");
  if (version !== null && !allowUnknown && !KNOWN_VERSIONS.includes(version)) {
    throw new Rejected(text(400, `Bad Request: Unsupported MCP-Protocol-Version: ${version}`));
  }
}

const headerMismatch = (id: RequestId | null, message: string) =>
  new Rejected(errorResponse(400, id, { code: ErrorCode.headerMismatch, message }));

/** The SEP-2243 headers, which requests of the 2026-07-28 protocol carry and which must match
 * the body. */
function checkStandardHeaders(headers: Headers, message: Message): void {
  const version = headers.get("mcp-protocol-version");
  if (version === null || version < NO_INITIALIZE || message.kind === "response") return;
  const id = message.kind === "request" ? message.id : null;
  const method = headers.get("mcp-method");
  if (message.kind === "request" && message.method === "initialize" && readsAs("initialize", message.params)) {
    if (method !== null && method !== "initialize") {
      throw headerMismatch(id, `Mcp-Method header \`${method}\` does not match body method \`initialize\``);
    }
    return;
  }
  if (method === null) throw headerMismatch(id, "missing required Mcp-Method header");
  if (method !== message.method) {
    throw headerMismatch(id, `Mcp-Method header \`${method}\` does not match body method \`${message.method}\``);
  }
  const expected = message.kind === "request" ? nameOf(message.method, message.params) : null;
  if (expected === null) return;
  const raw = headers.get("mcp-name");
  if (raw === null) throw headerMismatch(id, `missing required Mcp-Name header for \`${message.method}\``);
  const decoded = decodeHeader(raw);
  if (decoded === null) throw headerMismatch(id, "Mcp-Name header is not valid Base64");
  if (decoded !== expected) {
    throw headerMismatch(id, `Mcp-Name header \`${decoded}\` does not match body value \`${expected}\``);
  }
}

/** The `_meta` of a request against its version header: a version in `_meta` needs the same
 * one in the header, and a 2026-07-28 header or `server/discover` needs the `_meta` keys. */
function checkMetaVersion(headers: Headers, message: Extract<Message, { kind: "request" }>): void {
  if (message.method === "initialize" && readsAs("initialize", message.params)) return;
  const meta = metaOf(message.params);
  const header = headers.get("mcp-protocol-version");
  const version = metaVersion(meta);
  if (version === null) {
    const discover = message.method === "server/discover" && readsAs(message.method, message.params);
    if (discover || (header !== null && header >= NO_INITIALIZE)) {
      throw new Rejected(
        errorResponse(400, message.id, {
          code: ErrorCode.invalidParams,
          message: `Invalid params: request _meta is missing or has malformed required fields: ${missingMetaKeys(meta).join(", ")}`,
        }),
      );
    }
    return;
  }
  if (header === null) throw headerMismatch(message.id, "request _meta protocolVersion requires MCP-Protocol-Version header");
  if (header !== version) {
    throw headerMismatch(message.id, `MCP-Protocol-Version header (${header}) does not match request _meta protocolVersion (${version})`);
  }
}

/**
 * Whether `params` read as the request `method` names. A request whose params do not is not
 * one the server knows: `rmcp` reads it as a custom request, which no handler answers, and
 * none of the checks for its method apply to it.
 */
function readsAs(method: string, params: unknown): boolean {
  const absent = params === undefined || params === null;
  if (!absent && !isObject(params)) return false;
  const body = isObject(params) ? params : null;
  switch (method) {
    case "initialize": {
      const client = body?.clientInfo;
      return (
        typeof body?.protocolVersion === "string" &&
        isObject(body.capabilities) &&
        isObject(client) &&
        typeof client.name === "string" &&
        typeof client.version === "string"
      );
    }
    case "server/discover":
      return body !== null;
    case "tools/call":
      return typeof body?.name === "string" && (body.arguments === undefined || body.arguments === null || isObject(body.arguments));
    case "resources/read":
    case "resources/subscribe":
    case "resources/unsubscribe":
      return typeof body?.uri === "string";
    case "subscriptions/listen":
      return isObject(body?.notifications);
    default:
      return true;
  }
}

const methodNotFound = (method: string): ErrorData => ({ code: ErrorCode.methodNotFound, message: method });

/** How a request is answered: its JSON-RPC result or error, or the messages of a stream. */
type Answer =
  | { result: unknown }
  | { error: ErrorData }
  | { stream: (send: (message: unknown) => Promise<boolean>, signal: AbortSignal) => Promise<void> };

/** A tool reply: its value as pretty JSON, or its text as it is. */
function toolSuccess(value: unknown): JsonObject {
  const body = value instanceof Text ? value.text : rustJsonPretty(value);
  return { content: [{ type: "text", text: body }], isError: false };
}

/** A failed tool call: the kind and message as text for the agent to read, and the error
 * with its code (the codes of the RPC endpoint) as structured content `{"error": ...}`. */
export function toolError(error: CommandError): JsonObject {
  const kind = error.kind.charAt(0).toUpperCase() + error.kind.slice(1);
  return {
    content: [{ type: "text", text: `${kind}: ${error.message}` }],
    structuredContent: { error: { code: error.code, kind: error.kind, message: error.message } },
    isError: true,
  };
}

const TOOL_SCHEMAS = new Map(
  (TOOL_LIST as Array<{ name: string; inputSchema: JsonObject }>).map((entry) => [entry.name, entry.inputSchema]),
);

/** A failure of a tool's own logic as the tool error it reports; a bug that is no command
 * error reports as a panicked command, as the Rust server reports a panic. */
function failure(error: unknown): CommandError {
  try {
    return commandError(error);
  } catch {
    return panicked(error);
  }
}

/** The MCP endpoint: answers one request to `/mcp`, which the guard let through. */
export class McpService {
  readonly #backend: Backend;
  readonly #allowedHosts: readonly string[];

  constructor(backend: Backend, allowedHosts: readonly string[] = ["localhost", "127.0.0.1", "::1"]) {
    this.#backend = backend;
    this.#allowedHosts = allowedHosts;
  }

  async handle(request: Request, access: Access): Promise<Response> {
    try {
      checkHost(request, this.#allowedHosts);
      if (request.method !== "POST") {
        return text(405, "Method Not Allowed", { allow: "POST" });
      }
      return await this.#post(request, access);
    } catch (error) {
      if (error instanceof Rejected) return error.response;
      throw error;
    }
  }

  async #post(request: Request, access: Access): Promise<Response> {
    const types = acceptedTypes(request.headers).map((type) => type.toLowerCase());
    if (!types.includes(JSON_TYPE) || !types.includes(EVENT_STREAM)) {
      return text(406, "Not Acceptable: Client must accept both application/json and text/event-stream");
    }
    const contentType = request.headers.get("content-type");
    if (contentType === null || contentType.split(";")[0].trim().toLowerCase() !== JSON_TYPE) {
      return text(415, "Unsupported Media Type: Content-Type must be application/json");
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) {
      return text(413, `Payload Too Large: request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    const message = parseMessage(new TextDecoder().decode(bytes));
    const { headers } = request;
    const perRequest = message.kind === "request" && metaVersion(metaOf(message.params)) !== null;
    const typed = message.kind === "request" && readsAs(message.method, message.params);
    if (message.kind === "request" && message.method === "initialize" && typed) {
      const header = headers.get("mcp-protocol-version");
      const body = isObject(message.params) ? message.params.protocolVersion : undefined;
      if (header !== null && typeof body === "string" && header !== body) {
        return errorResponse(400, message.id, {
          code: ErrorCode.invalidRequest,
          message: `Invalid Request: MCP-Protocol-Version header (${header}) does not match initialize params.protocolVersion (${body})`,
        });
      }
    } else {
      checkVersionHeader(headers, perRequest);
    }
    checkStandardHeaders(headers, message);
    if (message.kind === "request") checkMetaVersion(headers, message);
    if (message.kind === "notification") return new Response(null, { status: 202 });
    if (message.kind === "response") {
      return errorResponse(400, null, {
        code: ErrorCode.invalidRequest,
        message: "stateless server does not accept JSON-RPC responses",
      });
    }
    const negotiated = perRequest || (message.method === "server/discover" && typed);
    const answer = await this.#answer(message, headers, request.signal, access);
    if ("stream" in answer) return this.#stream(message.id, answer.stream, request.signal);
    if ("result" in answer) return json(200, { jsonrpc: "2.0", id: message.id, result: answer.result });
    let status = 200;
    if (negotiated) {
      const malformed = missingMetaKeys(metaOf(message.params)).length > 0;
      const code = answer.error.code;
      if (code === ErrorCode.unsupportedProtocolVersion || code === ErrorCode.headerMismatch || code === -32021) status = 400;
      else if (code === ErrorCode.invalidParams && malformed) status = 400;
      else if (code === ErrorCode.methodNotFound) status = 404;
    }
    return errorResponse(status, message.id, answer.error);
  }

  /** Answers a request as the Rust server's handler does. Chat apps connected over OAuth get
   * their own instructions and only the tools their grant allows. Every grant may read
   * (its scopes are never empty), so the resources need no check. */
  async #answer(
    message: Extract<Message, { kind: "request" }>,
    headers: Headers,
    signal: AbortSignal,
    access: Access,
  ): Promise<Answer> {
    const { method, params } = message;
    if (!readsAs(method, params)) return { error: methodNotFound(method) };
    const body = isObject(params) ? params : {};
    const initialize = method === "initialize";
    const header = headers.get("mcp-protocol-version");
    const meta = metaOf(params);
    const requested = metaVersion(meta);
    const version = initialize ? (body.protocolVersion as string) : header ?? DEFAULT_VERSION;
    if (!initialize && requested !== null && !KNOWN_VERSIONS.includes(requested)) {
      return {
        error: {
          code: ErrorCode.unsupportedProtocolVersion,
          message: "Unsupported protocol version",
          data: { requested, supported: KNOWN_VERSIONS },
        },
      };
    }
    const requiresMeta = !initialize && (method === "server/discover" || (requested !== null && requested >= NO_INITIALIZE));
    if (requiresMeta) {
      const missing = missingMetaKeys(meta);
      if (missing.length > 0) {
        return {
          error: {
            code: ErrorCode.invalidParams,
            message: `request _meta is missing or has malformed required fields: ${missing.join(", ")}`,
          },
        };
      }
    }
    const legacy = !requiresMeta && version < NO_INITIALIZE;
    /** A list, read, or call result as the 2026-07-28 protocol shapes it. */
    const shaped = (fields: JsonObject, cached: boolean): JsonObject =>
      legacy ? fields : { resultType: "complete", ...(cached ? { ttlMs: 0, cacheScope: "private" } : {}), ...fields };
    switch (method) {
        case "initialize": {
          const agreed = KNOWN_VERSIONS.includes(version) && version < NO_INITIALIZE ? version : LATEST_WITH_INITIALIZE;
          return {
            result: {
              protocolVersion: agreed,
              capabilities: { resources: {}, tools: {} },
              serverInfo: this.#serverInfo(),
              instructions: access.kind === "oauth" ? CHAT_INSTRUCTIONS : INSTRUCTIONS,
            },
          };
        }
        case "server/discover":
          return {
            result: {
              resultType: "complete",
              supportedVersions: KNOWN_VERSIONS,
              capabilities: { resources: { subscribe: true, listChanged: true }, tools: {} },
              instructions: INSTRUCTIONS,
              ttlMs: 0,
              cacheScope: "private",
              _meta: { [META_SERVER_INFO]: this.#serverInfo() },
            },
          };
        case "ping":
          return legacy ? { result: {} } : { error: methodNotFound(method) };
        case "tools/list": {
          const tools =
            access.kind === "oauth"
              ? TOOL_LIST.filter((tool) => oauthRefusal(tool.name, access.grant.scopes) === null)
              : TOOL_LIST;
          return { result: shaped({ tools }, true) };
        }
        case "resources/list":
          return { result: shaped({ resources: resources.list(this.#backend.reader) }, true) };
        case "resources/templates/list":
          return { result: shaped({ resourceTemplates: resources.templates() }, true) };
        case "resources/read": {
          const uri = body.uri as string;
          const notFound: ErrorData = {
            code: legacy ? ErrorCode.resourceNotFound : ErrorCode.invalidParams,
            message: resources.unknown(uri),
          };
          const id = resources.parseUri(uri);
          if (id === null) return { error: notFound };
          let content: string;
          try {
            content = resources.read(this.#backend.reader, id);
          } catch (error) {
            const reported = failure(error);
            if (reported.code === "taskNotFound") return { error: notFound };
            return { error: { code: ErrorCode.internal, message: reported.message } };
          }
          return { result: shaped({ contents: [{ uri, mimeType: JSON_TYPE, text: content }] }, true) };
        }
        case "tools/call": {
          const name = body.name as string;
          if (access.kind === "oauth") {
            const refused = oauthRefusal(name, access.grant.scopes);
            if (refused !== null) return { result: shaped(toolError(new CommandError("notPermitted", refused)), false) };
            if (name === "read_toodo_skill") return { result: shaped(toolSuccess(new Text(CHAT_INSTRUCTIONS)), false) };
          }
          const args = body.arguments;
          const called = await this.#call(body.name as string, isObject(args) ? args : null);
          if (called === null) return { error: { code: ErrorCode.invalidParams, message: "tool not found" } };
          return { result: shaped(called, false) };
        }
        case "subscriptions/listen":
          if (legacy) return { error: methodNotFound(method) };
          return { stream: this.#listen(message.id, body.notifications as JsonObject, signal) };
        default:
          return { error: methodNotFound(method) };
    }
  }

  #serverInfo(): JsonObject {
    return { name: "toodo", title: `Toodo (server instance ${this.#backend.mcp.instance})`, version: VERSION };
  }

  /** Calls tool `name` with `args`; digit strings where its schema takes integers become
   * numbers first, as agents often send IDs as strings. `null` when there is no such tool. */
  async #call(name: string, args: JsonObject | null): Promise<JsonObject | null> {
    const tool = TOOLS[name];
    const schema = TOOL_SCHEMAS.get(name);
    if (tool === undefined || schema === undefined) return null;
    let converted: JsonObject = args ?? {};
    if (args !== null) {
      try {
        converted = numbersFromStrings(schema, args);
      } catch (error) {
        if (error instanceof ArgumentError) return toolError(new CommandError("invalidArguments", error.message));
        throw error;
      }
    }
    const backend = this.#backend;
    try {
      return toolSuccess(await tool({ storage: backend.storage, reader: backend.reader, notifier: backend }, converted));
    } catch (error) {
      if (error instanceof ArgumentError) {
        return { content: [{ type: "text", text: `failed to deserialize parameters: ${error.message}` }], isError: true };
      }
      return toolError(failure(error));
    }
  }

  /** The stream of a `subscriptions/listen` request: the acknowledgment of what the server
   * accepted, then a notification whenever a watched task or the list of open tasks changes,
   * read again on every announced change and every `POLL_MS`, until the client closes it. */
  #listen(id: RequestId, requested: JsonObject, signal: AbortSignal): Extract<Answer, { stream: unknown }>["stream"] {
    const uris = Array.isArray(requested.resourceSubscriptions)
      ? requested.resourceSubscriptions.filter((uri): uri is string => typeof uri === "string" && resources.parseUri(uri) !== null)
      : [];
    const accepted: resources.SubscriptionFilter = {};
    if (requested.resourcesListChanged === true) accepted.resourcesListChanged = true;
    if (uris.length > 0) accepted.resourceSubscriptions = uris;
    const meta = { [META_SUBSCRIPTION_ID]: id };
    const notification = (method: string, params: JsonObject) => ({ jsonrpc: "2.0", method, params: sortedKeys({ _meta: meta, ...params }) });
    return async (send) => {
      let changed: () => void = () => {};
      const unsubscribe = this.#backend.onChange(() => changed());
      try {
        const watch = new resources.Watch(this.#backend.reader, accepted);
        if (!(await send(notification("notifications/subscriptions/acknowledged", { notifications: accepted })))) return;
        while (!signal.aborted) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, resources.POLL_MS);
            const done = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", done);
              resolve();
            };
            changed = done;
            signal.addEventListener("abort", done);
          });
          if (signal.aborted) return;
          const { updated, listChanged } = watch.next(this.#backend.reader);
          for (const uri of updated) {
            if (!(await send(notification("notifications/resources/updated", { uri })))) return;
          }
          if (listChanged && !(await send(notification("notifications/resources/list_changed", {})))) return;
        }
      } finally {
        unsubscribe();
      }
    };
  }

  /** A server-sent event stream of the messages `produce` sends, with a keep-alive comment
   * every `KEEP_ALIVE_MS`. */
  #stream(
    id: RequestId,
    produce: (send: (message: unknown) => Promise<boolean>, signal: AbortSignal) => Promise<void>,
    signal: AbortSignal,
  ): Response {
    const encoder = new TextEncoder();
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        let open = true;
        const close = () => {
          if (!open) return;
          open = false;
          clearInterval(keepAlive);
          try {
            controller.close();
          } catch {
            // The client already closed the stream.
          }
        };
        const write = (chunk: string) => {
          if (!open) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            open = false;
            return false;
          }
        };
        keepAlive = setInterval(() => write(":\n\n"), KEEP_ALIVE_MS);
        signal.addEventListener("abort", close);
        produce(async (message) => write(`data: ${JSON.stringify(message)}\n\n`), signal)
          .catch((error: unknown) => {
            write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: ErrorCode.internal, message: failure(error).message } })}\n\n`);
          })
          .finally(close);
      },
      cancel: () => clearInterval(keepAlive),
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": EVENT_STREAM, "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  }
}


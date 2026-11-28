// `/runner-enroll/` on the core: what a computer enrolled by a pasted command (Settings > Machines & accounts > Add a
// computer) downloads and sends. `GET /runner-enroll/install.sh` and `install.ps1` are the bootstrap scripts, which hold
// no secret; `GET /runner-enroll/script?label=&shell=` is the runner's installer and `POST /runner-enroll/exchange?label=`
// its enrollment request, both behind the download token in `X-Dori-Enroll` that only the holder of the one-time code
// can make. These routes sit outside the `/api` gate, since the new computer has no web token. The core runs nothing and
// checks only the shape of each request: the supervisor Worker matches the token against its live codes (a mismatch is
// 403) and answers (dori runner/paste-enroll.ts).

import { ENROLL_SHELLS, ENROLL_TOKEN_HEADER, type EnrollShell, type MachineReply } from "../../../src/lib/machines.ts";
import { json } from "./auth.ts";
import { ask, type MachineBridge, REQUEST_LIMIT, replyStatus } from "./machines.ts";

export const ENROLL_PREFIX = "/runner-enroll/";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const BOOTSTRAPS: Record<string, EnrollShell> = { "install.sh": "posix", "install.ps1": "windows" };

const failure = (status: number, error: string, refused = false): Response =>
  json(status, { ok: false, error, ...(refused ? { refused } : {}) } satisfies MachineReply);

const scriptResponse = (reply: MachineReply | Response): Response => {
  if (reply instanceof Response) return reply;
  if (!reply.ok || !("script" in reply)) return json(replyStatus(reply), reply);
  return new Response(reply.script, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

/** The label and download token of a request, or the answer that refuses it. */
function credentials(request: Request, url: URL): { label: string; token: string } | Response {
  const label = url.searchParams.get("label") ?? "";
  if (!LABEL.test(label)) return failure(400, "label is missing or not a runner label");
  const token = request.headers.get(ENROLL_TOKEN_HEADER) ?? "";
  if (!TOKEN.test(token)) return failure(401, `the ${ENROLL_TOKEN_HEADER} header must carry the enrollment download token`, true);
  return { label, token };
}

/** Answers a `/runner-enroll/` request. */
export async function route(bridge: MachineBridge | null, request: Request, pathname: string): Promise<Response> {
  const name = pathname.slice(ENROLL_PREFIX.length);
  const url = new URL(request.url);
  const method = name === "exchange" ? "POST" : "GET";
  const known = name in BOOTSTRAPS || name === "script" || name === "exchange";
  if (!known) return failure(404, "Not Found");
  if (request.method !== method && !(method === "GET" && request.method === "HEAD")) {
    return new Response(null, { status: 405, headers: { allow: method } });
  }
  const shell = BOOTSTRAPS[name];
  if (shell !== undefined) return scriptResponse(await ask(bridge, { op: "enroll-bootstrap", shell }));
  const who = credentials(request, url);
  if (who instanceof Response) return who;
  if (name === "script") {
    const wanted = url.searchParams.get("shell");
    if (!(ENROLL_SHELLS as readonly (string | null)[]).includes(wanted)) return failure(400, "shell must be posix or windows");
    return scriptResponse(await ask(bridge, { op: "enroll-script", ...who, shell: wanted as EnrollShell }));
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).length > REQUEST_LIMIT) return failure(413, `the request is larger than ${REQUEST_LIMIT} bytes`);
  if (body.trim() === "") return failure(400, "the body must carry the runner's enrollment request");
  const reply = await ask(bridge, { op: "enroll-exchange", ...who, request: body });
  return reply instanceof Response ? reply : json(replyStatus(reply), reply);
}

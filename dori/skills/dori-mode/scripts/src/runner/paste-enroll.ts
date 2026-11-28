// Enrolling a computer the host has no ssh access to, from Settings > Machines & accounts (machine-admin.ts). The web
// app asks for a one-time code (SupervisorAuth.issueCode: 10 minutes, bound to the label) and shows a one-line command
// that carries the code and the supervisor key's fingerprint in the new computer's environment. That command downloads
// the bootstrap script (templates/runner-enroll.sh or .ps1) from the Toodo server's `/runner-enroll/` routes, which the
// core relays here. The bootstrap proves it holds the code with a download token (sha256 of a tag, the label and the
// code; the code itself never travels), downloads the same install script an ssh install sends (install.ts
// pasteInstallScript), checks that it pins the fingerprint from the command, and runs it. Its first pass prints the
// runner's enrollment request and exits 9; the bootstrap posts that request back, SupervisorAuth accepts it (the code is
// then used up) and the runner's private endpoint is recorded, and the second download carries the `enroll.ok` reply,
// which the runner checks against the fingerprint before it pins the supervisor key and starts its service.

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { HOST_MACHINE, type EnrollShell, type Enrollment } from "../../../../../../src/lib/machines.ts";
import { HC_INSTALL_URL } from "../runtime/hc.ts";
import type { SupervisorAuth } from "./auth.ts";
import { RUNNER_PORT, writeRunnerEndpoint } from "./endpoints.ts";
import { enrollReply, pasteInstallScript } from "./install.ts";
import { LABEL_PATTERN } from "./protocol.ts";
import { isPrivateListen } from "./ws-transport.ts";

/** The tag the download token hashes in front of the label and the code; the bootstrap scripts hash the same text. */
export const ENROLL_DOWNLOAD_TAG = "dori-runner-enroll-download-1";

const TEMPLATES = join(import.meta.dir, "..", "..", "templates");
export const BOOTSTRAP_TEMPLATES: Record<EnrollShell, string> = {
  posix: join(TEMPLATES, "runner-enroll.sh"),
  windows: join(TEMPLATES, "runner-enroll.ps1"),
};

/** The token that proves a download comes from whoever holds `code`: hex sha256 of `<tag>\n<label>\n<code>`. */
export const downloadToken = (label: string, code: string): string =>
  createHash("sha256").update(`${ENROLL_DOWNLOAD_TAG}\n${label}\n${code}`).digest("hex");

/** The bootstrap script the pasted command downloads, with its `@NAME@` markers filled. */
export const bootstrapScript = (shell: EnrollShell): string =>
  readFileSync(BOOTSTRAP_TEMPLATES[shell], "utf8").replaceAll("@TOKEN_TAG@", ENROLL_DOWNLOAD_TAG).replaceAll("@HC_INSTALL_URL@", HC_INSTALL_URL);

/** A download token or an enrollment request that did not match a live code: the core answers 403. */
export class EnrollRefused extends Error {}

/** The private host:port the supervisor dials for `address` (an IP on the LAN or Tailscale), or why it cannot. */
export const enrollListen = (address: string): string => {
  const host = address.trim();
  const listen = `${host.includes(":") ? `[${host}]` : host}:${RUNNER_PORT}`;
  if (!isPrivateListen(listen)) {
    throw new Error(`RUNNER_LISTEN_REFUSED ${host || "(empty)"} is not a private IP address: the supervisor reaches runners only on the LAN or Tailscale (10.x, 172.16-31.x, 192.168.x, 100.64-127.x, fd00::/8)`);
  }
  return listen;
};

type Pending = { readonly label: string; readonly listen: string; readonly expiresAt: number; reply?: string };

export type PasteEnrollDeps = {
  readonly auth: () => SupervisorAuth;
  /** The runner bundle (install.ts buildBundle), built once and shared. */
  readonly bundle: () => Promise<string>;
  /** The lead's agent command, for the starter runner-config.json of a new runner. */
  readonly agentCommand: readonly string[];
  readonly stateDir: string;
  readonly now: () => number;
};

/** The enrollments the web app started, by code; kept in memory, so a Worker restart asks for a new command. */
export class PasteEnrollments {
  readonly #deps: PasteEnrollDeps;
  readonly #pending = new Map<string, Pending>();

  constructor(deps: PasteEnrollDeps) {
    this.#deps = deps;
  }

  issue(label: string, address: string): Enrollment {
    if (!LABEL_PATTERN.test(label)) throw new Error(`${label || "(empty)"} is not a label: letters, digits, dot, dash and underscore`);
    if (label === HOST_MACHINE) throw new Error(`${HOST_MACHINE} is the server host's own runner`);
    const listen = enrollListen(address);
    const auth = this.#deps.auth();
    const now = this.#deps.now();
    for (const [code, pending] of this.#pending) if (pending.expiresAt <= now) this.#pending.delete(code);
    const { code, expiresAt } = auth.issueCode(label);
    this.#pending.set(code, { label, listen, expiresAt });
    // Built now so the new computer's download does not wait for it; a failed build is reported by that download.
    this.#deps.bundle().catch(() => undefined);
    return { label, code, fingerprint: auth.fingerprint, listen, expiresAt };
  }

  #match(label: string, token: string): { readonly code: string; readonly pending: Pending } {
    const wanted = Buffer.from(token, "utf8");
    for (const code of this.#deps.auth().liveCodes(label)) {
      const expected = Buffer.from(downloadToken(label, code), "utf8");
      if (expected.length !== wanted.length || !timingSafeEqual(expected, wanted)) continue;
      const pending = this.#pending.get(code);
      if (pending === undefined) throw new EnrollRefused("this command was made before Dori restarted; make a new one in the web app");
      return { code, pending };
    }
    throw new EnrollRefused(`no live enrollment code of ${label} matches: the command expired (10 minutes) or is not this server's; make a new one in the web app`);
  }

  /** The install script for `shell`, with the code, and after the exchange its reply. */
  async script(label: string, shell: EnrollShell, token: string): Promise<string> {
    const { code, pending } = this.#match(label, token);
    const issue = { code, fingerprint: this.#deps.auth().fingerprint, ...(pending.reply === undefined ? {} : { reply: pending.reply }) };
    return pasteInstallScript(shell, await this.#deps.bundle(), label, pending.listen, issue, this.#deps.agentCommand);
  }

  /** Accepts the runner's enrollment request (the code is used up) and records its endpoint; answers the enrolled label. */
  exchange(label: string, token: string, request: string): string {
    const { pending } = this.#match(label, token);
    const auth = this.#deps.auth();
    let reply: string;
    try {
      reply = enrollReply(`RUNNER_ENROLL_REQUEST ${request.trim()}`, { label, enroll: (body) => auth.enroll(body) }, "the enrollment request");
    } catch (e) {
      throw new EnrollRefused(e instanceof Error ? e.message : String(e));
    }
    pending.reply = reply;
    writeRunnerEndpoint(this.#deps.stateDir, label, pending.listen);
    return label;
  }
}

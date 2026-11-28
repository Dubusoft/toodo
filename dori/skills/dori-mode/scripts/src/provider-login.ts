// Signing in the agent accounts omo uses (a Claude subscription, a ChatGPT subscription for Codex) on a Dori host, as
// Settings > Machines & accounts starts it. omo has no command for that sign-in, so this drives `omo --mode rpc` as
// omo's own clients do (`login_start`, `extension_ui_request` / `extension_ui_response`, `auth_login_url`,
// `auth_login_end`) and takes the routes that need no browser on the host: Claude's copy-code login and Codex's browser
// login with its paste field. The owner opens the sign-in page on any device and pastes back the code (Claude) or the
// address the page ends on (Codex), which reaches omo and nothing else. The supervisor runs it on its own host
// (machine-admin.ts) and a runner on its host (runner/tool-jobs.ts). It also reads each account's sign-in state with
// `omo auth check`, which prints no credential without `--credentials`.
import type { Runner } from "./run.ts";

export type Provider = "claude" | "codex";
/** omo's provider id of each account. */
export const OMO_PROVIDERS: Readonly<Record<Provider, string>> = { claude: "anthropic-subscription", codex: "chatgpt-subscription" };

/** The sign-in page and the question a sign-in waits on (src/lib/machines.ts SignInPrompt). */
export type SignIn = { readonly url: string | null; readonly ask: string | null };
/** One account's sign-in on a host (src/lib/machines.ts ProviderLogin). */
export type ProviderLogin = { readonly signedIn: boolean; readonly accounts: number };
export type ProviderLogins = { readonly [P in Provider]: ProviderLogin };

/** The command line a sign-in job's log opens with. */
export const loginCommand = (provider: Provider): string => `omo --mode rpc (sign in ${OMO_PROVIDERS[provider]})`;

/** A sign-in the owner does not finish within this time ends failed. */
export const PROVIDER_LOGIN_TIMEOUT_MS = 15 * 60_000;
const AUTH_CHECK_TIMEOUT_MS = 30_000;
/** How often a sign-in that omo cancelled while its session was still starting (`session closed`) is started again. */
const SESSION_RESTARTS = 2;
/** How long a cancelled sign-in waits for omo's own end before it is killed. */
const CANCEL_GRACE_MS = 5_000;

/**
 * The choices each sign-in makes, matched by their label in the order omo asks. Codex: "Continue with ChatGPT" needs an
 * OmO-registered device, and the device-code login loses its user code over RPC (omo sends only the verification URL),
 * so it takes the legacy browser login, whose paste field accepts the address the page ends on. Claude: the copy-code
 * login, whose page shows the code to paste.
 */
const ROUTES: Readonly<Record<Provider, readonly RegExp[]>> = {
  claude: [/copy code/i],
  codex: [/^legacy/i, /^browser/i],
};

/** omo's account-name question; answered with its first existing account (signed in again), or Enter for a first one. */
const ACCOUNT_NAME = /^Name for this account\b/;

/** The account a sign-in signs in again: the first of `existing: a, b; ...` in omo's question, or "" for omo's default. */
export const accountToReuse = (title: string): string => /existing: ([^;)]+)/.exec(title)?.[1]?.split(",")[0]?.trim() ?? "";

/** The option of `options` the sign-in of `provider` takes, or undefined when none is one it knows. */
export const routeChoice = (provider: Provider, options: readonly string[]): string | undefined =>
  ROUTES[provider].map((re) => options.find((o) => re.test(o))).find((o) => o !== undefined);

export type ProviderLoginEnd = { readonly state: "succeeded" | "failed" | "cancelled"; readonly error: string | null };

export type ProviderLoginHandle = {
  /** Passes the owner's answer to the question omo waits on; throws when it waits on none. */
  readonly answer: (value: string) => void;
  readonly cancel: () => void;
};

type RpcFrame = {
  readonly id?: string; readonly type?: string; readonly method?: string; readonly title?: string; readonly options?: unknown;
  readonly url?: string; readonly text?: string; readonly success?: boolean; readonly error?: string;
  readonly account?: { readonly name?: string }; readonly check?: { readonly outcome?: string; readonly reason?: string };
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Starts signing in `provider` inside omo. `onLog` gets each step as a line (never an answer), `onSignIn` the page and
 * question whenever they change, and `onEnd` the outcome once. `argv` is omo's RPC command (tests replace it).
 */
export const startProviderLogin = (opts: {
  readonly provider: Provider; readonly env: Record<string, string>; readonly cwd: string; readonly timeoutMs?: number;
  readonly argv?: readonly string[];
  readonly onLog: (line: string) => void; readonly onSignIn: (signIn: SignIn) => void; readonly onEnd: (end: ProviderLoginEnd) => void;
}): ProviderLoginHandle => {
  const provider = OMO_PROVIDERS[opts.provider];
  let ended = false;
  let cancelled = false;
  let restarts = 0;
  let url: string | null = null;
  let pending: { readonly id: string; readonly title: string } | null = null;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let proc: ReturnType<typeof spawnRpc> | undefined;

  const end = (state: ProviderLoginEnd["state"], error: string | null): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    proc?.kill();
    opts.onEnd({ state, error });
  };
  const timer = setTimeout(() => {
    opts.onLog(`The sign-in was not finished within ${Math.round((opts.timeoutMs ?? PROVIDER_LOGIN_TIMEOUT_MS) / 60_000)} minutes.`);
    end("failed", "timed out");
  }, opts.timeoutMs ?? PROVIDER_LOGIN_TIMEOUT_MS);
  const send = (frame: Record<string, unknown>): void => {
    proc?.stdin.write(`${JSON.stringify(frame)}\n`);
    void proc?.stdin.flush();
  };
  const publish = (): void => { opts.onSignIn({ url, ask: pending?.title ?? null }); };
  const startLogin = (): void => { send({ id: "login", type: "login_start", provider }); };

  const onFrame = (frame: RpcFrame): void => {
    if (frame.type === "response") {
      if (frame.id === "providers") startLogin();
      else if (frame.success === false && frame.id !== "cancel") end("failed", frame.error ?? "omo refused the sign-in");
      return;
    }
    if (frame.type === "auth_login_url" && typeof frame.url === "string") {
      url = frame.url;
      opts.onLog(`Sign-in page: ${url}`);
      publish();
      return;
    }
    if (frame.type === "auth_login_progress" && typeof frame.text === "string") {
      opts.onLog(frame.text);
      return;
    }
    if (frame.type === "auth_login_end") {
      if (frame.success === true) {
        const as = frame.account?.name ? ` as account ${frame.account.name}` : "";
        const check = frame.check?.outcome ? `; connection test ${frame.check.outcome}${frame.check.reason ? ` (${frame.check.reason})` : ""}` : "";
        opts.onLog(`Signed in${as}${check}.`);
        end("succeeded", null);
      } else if (!cancelled && restarts < SESSION_RESTARTS && /session closed/i.test(frame.error ?? "")) {
        restarts += 1;
        url = null;
        pending = null;
        publish();
        opts.onLog("omo restarted its session; starting the sign-in again.");
        startLogin();
      } else {
        if (frame.error) opts.onLog(frame.error);
        end(cancelled ? "cancelled" : "failed", cancelled ? null : frame.error ?? "the sign-in failed");
      }
      return;
    }
    if (frame.type !== "extension_ui_request" || typeof frame.id !== "string") return;
    if (frame.method === "select") {
      const options = Array.isArray(frame.options) ? frame.options.filter((o): o is string => typeof o === "string") : [];
      const choice = routeChoice(opts.provider, options);
      if (choice === undefined) {
        send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        end("failed", `omo offered sign-in choices this page cannot pick: ${options.join(" / ")}`);
        return;
      }
      opts.onLog(`${frame.title ?? "Choice"} ${choice}`);
      send({ type: "extension_ui_response", id: frame.id, value: choice });
    } else if (frame.method === "input") {
      const title = frame.title ?? "";
      if (ACCOUNT_NAME.test(title)) {
        const name = accountToReuse(title);
        opts.onLog(name ? `Signing in account ${name} again.` : "Signing in a new account.");
        send({ type: "extension_ui_response", id: frame.id, value: name });
        return;
      }
      pending = { id: frame.id, title };
      opts.onLog(`Waiting for the answer to: ${title}`);
      publish();
    } else if (frame.method === "confirm") {
      send({ type: "extension_ui_response", id: frame.id, cancelled: true });
      end("failed", `omo asked something this page cannot answer: ${frame.title ?? ""}`);
    }
  };

  try {
    proc = spawnRpc(opts.argv ?? ["omo", "--mode", "rpc"], opts.env, opts.cwd);
  } catch (e) {
    queueMicrotask(() => { end("failed", `omo could not start: ${errorText(e)}`); });
    return { answer: () => { throw new Error("the sign-in is not running"); }, cancel: () => {} };
  }
  const running = proc;
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of running.stdout) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          let frame: unknown;
          try { frame = JSON.parse(line); } catch { continue; }
          if (typeof frame === "object" && frame !== null && !ended) onFrame(frame as RpcFrame);
        }
      }
    } catch (e) {
      opts.onLog(`omo's output could not be read: ${errorText(e)}`);
    }
    const code = await running.exited;
    end(cancelled ? "cancelled" : "failed", cancelled ? null : `omo exited (code ${code}) before the sign-in ended`);
  })();
  opts.onLog(`Signing in ${provider} inside omo.`);
  send({ id: "providers", type: "get_auth_providers" });

  return {
    answer: (value) => {
      if (ended || pending === null) throw new Error("the sign-in is not waiting for an answer");
      send({ type: "extension_ui_response", id: pending.id, value: value.trim() });
      pending = null;
      opts.onLog("Answer received; omo checks it.");
      publish();
    },
    cancel: () => {
      if (ended) return;
      cancelled = true;
      send({ id: "cancel", type: "login_cancel", provider });
      killTimer = setTimeout(() => { end("cancelled", null); }, CANCEL_GRACE_MS);
    },
  };
};

const spawnRpc = (argv: readonly string[], env: Record<string, string>, cwd: string) =>
  Bun.spawn([...argv], { env, cwd, stdin: "pipe", stdout: "pipe", stderr: "ignore" });

/** One account's state in `omo auth check --json` output, or undefined when it is not that answer. */
export const parseAuthCheck = (out: string): ProviderLogin | undefined => {
  let parsed: unknown;
  try { parsed = JSON.parse(out.trim().split("\n").at(-1) ?? ""); } catch { return undefined; }
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) return undefined;
  const accounts = "accounts" in parsed && Array.isArray(parsed.accounts) ? (parsed.accounts as unknown[]) : [];
  const signedIn = parsed.status === "ready"
    || accounts.some((a) => typeof a === "object" && a !== null && "signIn" in a && a.signIn === "signed_in");
  return { signedIn, accounts: accounts.length };
};

/** Each account's sign-in on this host, or null when omo cannot be asked (not installed, or no answer). */
export const readProviderLogins = async (run: Runner): Promise<ProviderLogins | null> => {
  const read = async (p: Provider): Promise<ProviderLogin | undefined> => {
    const r = await run(["omo", "auth", "check", "--provider", OMO_PROVIDERS[p], "--json", "--no-refresh"], { timeoutMs: AUTH_CHECK_TIMEOUT_MS })
      .catch(() => undefined);
    return r === undefined ? undefined : parseAuthCheck(r.out);
  };
  const [claude, codex] = await Promise.all([read("claude"), read("codex")]);
  return claude && codex ? { claude, codex } : null;
};

// Compares two Toodo servers, such as the Rust server and its TypeScript port, by what they
// answer and store. See docs/parity.md.
//
//   node scripts/parity/parity.ts replay [--a CMD] [--b CMD] [--db FILE] [--out DIR] [--keep]
//   node scripts/parity/parity.ts shadow --live FILE [--reference CMD] [--candidate CMD]
//                                        [--rounds N] [--interval SECONDS] [--out DIR]
//   node scripts/parity/parity.ts rust-check --db FILE [--bin CMD]
//   node scripts/parity/parity.ts inventory [--bin CMD] [--write]

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { copyDatabase, dumpDatabase, integrityCheck, isolateCopy, userVersion } from "./dump.ts";
import { normalizeEventId, normalizeText, normalizeValue, type Normalizer } from "./normalize.ts";
import { readSteps } from "./reads.ts";
import { marker, scenario } from "./scenario.ts";
import { startServer, type Reply, type RunningServer, type ServerSpec, type SseEvent } from "./server.ts";
import { data, run, type Results, type Step } from "./steps.ts";

const root = path.resolve(import.meta.dirname, "../..");
const DATABASE_FILE = "toodo.sqlite3";
const INVENTORY = path.join(import.meta.dirname, "inventory.json");
const DEFAULT_SERVER = path.join(root, "src-tauri", "target", "debug", "toodo-server");

type Inventory = { commands: string[]; tools: string[] };
type Difference = { surface: string; name: string; a: string; b: string };

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : item,
  );

function spec(label: string, command: string | undefined): ServerSpec {
  return { label, command: (command ?? DEFAULT_SERVER).split(" ").filter((part) => part !== "") };
}

function normalizerFor(server: RunningServer, from: number, to: number): Normalizer {
  const dirs = new Set([server.dataDir, realpathSync(server.dataDir)]);
  const token = (file: string) => readFileSync(path.join(server.dataDir, file), "utf8").trim();
  return {
    from,
    to,
    replacements: [
      ...[...dirs].map((dir): [string, string] => [dir, "<data-dir>"]),
      [server.url, "<url>"],
      [server.url.replace("http://", ""), "<listen>"],
      [token("mcp-token"), "<mcp-token>"],
      [token("web-token"), "<web-token>"],
    ],
  };
}

/** The commands of `src-tauri/src/bindings.rs`, in the order it lists them. */
export function bindingsCommands(): string[] {
  const source = readFileSync(path.join(root, "src-tauri", "src", "bindings.rs"), "utf8");
  const start = source.indexOf("collect_functions![");
  const block = source.slice(start, source.indexOf("](types)", start));
  return [...block.matchAll(/^\s+[\w:]+::(\w+),$/gm)].map((match) => match[1]);
}

function toolNames(reply: Reply | undefined): string[] {
  const tools = (reply?.body as { result?: { tools?: Array<{ name: string }> } } | undefined)?.result?.tools ?? [];
  return tools.map((tool) => tool.name).sort();
}

function readInventory(): Inventory {
  return JSON.parse(readFileSync(INVENTORY, "utf8")) as Inventory;
}

/** Differences between two lists of lines: the lines only one side has, up to `limit` each. */
function lineDiff(a: string[], b: string[], limit = 20): { onlyA: string[]; onlyB: string[] } {
  const count = (lines: string[]) => {
    const map = new Map<string, number>();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const ca = count(a);
  const cb = count(b);
  const only = (lines: string[], mine: Map<string, number>, theirs: Map<string, number>) => {
    const out: string[] = [];
    const seen = new Map<string, number>();
    for (const line of lines) {
      const n = (seen.get(line) ?? 0) + 1;
      seen.set(line, n);
      if (n > (theirs.get(line) ?? 0) && n <= (mine.get(line) ?? 0) && out.length < limit) out.push(line);
    }
    return out;
  };
  const onlyA = only(a, ca, cb);
  const onlyB = only(b, cb, ca);
  const ordered = onlyA.length === 0 && onlyB.length === 0 && a.join("\n") !== b.join("\n");
  return ordered ? { onlyA: ["(same lines in another order)"], onlyB: [] } : { onlyA, onlyB };
}

type Run = { steps: Step[]; a: Reply[]; b: Reply[]; called: { rpc: Set<string>; tools: Set<string> } };

/** Runs every step on both servers, each building its arguments from its own answers. */
async function runBoth(steps: Step[], a: RunningServer, b: RunningServer): Promise<Run> {
  const own: { a: Results; b: Results } = { a: new Map(), b: new Map() };
  const result: Run = { steps, a: [], b: [], called: { rpc: new Set(), tools: new Set() } };
  for (const step of steps) {
    const callA = step.call(own.a);
    const callB = step.call(own.b);
    if ("rpc" in callA) result.called.rpc.add(callA.rpc);
    if ("tool" in callA) result.called.tools.add(callA.tool);
    const [ra, rb] = await Promise.all([run(a, callA), run(b, callB)]);
    own.a.set(step.name, ra);
    own.b.set(step.name, rb);
    result.a.push(ra);
    result.b.push(rb);
  }
  return result;
}

function compareReplies(outcome: Run, na: Normalizer, nb: Normalizer): Difference[] {
  const differences: Difference[] = [];
  outcome.steps.forEach((step, index) => {
    const a = canonical(normalizeValue(na, outcome.a[index]));
    const b = canonical(normalizeValue(nb, outcome.b[index]));
    if (a !== b) differences.push({ surface: "reply", name: step.name, a, b });
  });
  return differences;
}

function compareEvents(a: SseEvent[], b: SseEvent[], na: Normalizer, nb: Normalizer): Difference[] {
  const shape = (events: SseEvent[], n: Normalizer) =>
    events.map((event) =>
      canonical({
        id: normalizeEventId(event.id),
        event: event.event,
        data: event.event === "ready" ? normalizeEventId(event.data) : normalizeText(n, event.data),
      }),
    );
  const sa = shape(a, na);
  const sb = shape(b, nb);
  const differences: Difference[] = [];
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    if (sa[i] !== sb[i]) differences.push({ surface: "event", name: `#${i}`, a: sa[i] ?? "(none)", b: sb[i] ?? "(none)" });
  }
  return differences;
}

function compareDumps(a: string, b: string, na: Normalizer, nb: Normalizer): { lines: number; differences: Difference[] } {
  const da = dumpDatabase(a).map((line) => normalizeText(na, line));
  const db = dumpDatabase(b).map((line) => normalizeText(nb, line));
  const { onlyA, onlyB } = lineDiff(da, db);
  if (onlyA.length === 0 && onlyB.length === 0) return { lines: da.length, differences: [] };
  return { lines: da.length, differences: [{ surface: "dump", name: DATABASE_FILE, a: onlyA.join("\n"), b: onlyB.join("\n") }] };
}

function printDifferences(differences: Difference[], limit = 30) {
  for (const difference of differences.slice(0, limit)) {
    console.log(`\n--- ${difference.surface} ${difference.name}`);
    console.log(`A: ${difference.a.slice(0, 2000)}`);
    console.log(`B: ${difference.b.slice(0, 2000)}`);
  }
  if (differences.length > limit) console.log(`\n... and ${differences.length - limit} more`);
}

function prepareCopies(work: string, source: string | undefined, sides: string[]): string[] {
  return sides.map((side) => {
    const dir = path.join(work, side);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (source !== undefined) {
      copyDatabase(source, path.join(dir, DATABASE_FILE));
      isolateCopy(path.join(dir, DATABASE_FILE));
    }
    return dir;
  });
}

/** Environment for every server the harness starts: no outside calls, the same agent name. */
function harnessEnv(work: string): Record<string, string> {
  return {
    TOODO_NPM_REGISTRY: "http://127.0.0.1:9",
    TOODO_CHAT_AGENT_NAME: "Agent",
    TMPDIR: work,
  };
}

async function replay(options: Record<string, string | boolean | undefined>): Promise<number> {
  const work = mkdtempSync(path.join(tmpdir(), "toodo-parity-"));
  const out = typeof options.out === "string" ? options.out : path.join(work, "report");
  mkdirSync(out, { recursive: true });
  const from = Math.floor(Date.now() / 1000);
  const [dirA, dirB] = prepareCopies(work, options.db as string | undefined, ["a", "b"]);
  const env = harnessEnv(work);
  const a = await startServer(spec("A", options.a as string | undefined), dirA, env);
  let b: RunningServer | undefined;
  try {
    b = await startServer(spec("B", options.b as string | undefined), dirB, env);
    const [eventsA, eventsB] = await Promise.all([a.openEvents(), b.openEvents()]);
    const outcome = await runBoth([...scenario, ...markerSteps], a, b);
    const markerTask = (reply: Reply) => (data(reply) as { id?: number }).id;
    const markerIndex = outcome.steps.findIndex((step) => step.name === "create_task#marker");
    const markerA = markerTask(outcome.a[markerIndex]);
    const markerB = markerTask(outcome.b[markerIndex]);
    const startedMarker = (id: number | undefined) => (event: SseEvent) =>
      event.event === "task-status-changed" && new RegExp(`"(?:id|taskId)":${id}\\b`).test(event.data);
    const arrived = await Promise.all(
      [eventsA.waitFor(startedMarker(markerA), 15_000), eventsB.waitFor(startedMarker(markerB), 15_000)].map((wait) =>
        wait.then(
          () => true,
          () => false,
        ),
      ),
    );
    await Promise.all([a.stop(), b.stop()]);
    const to = Math.floor(Date.now() / 1000);
    const na = normalizerFor(a, from, to);
    const nb = normalizerFor(b, from, to);

    const differences: Difference[] = [];
    if (!arrived.every(Boolean)) {
      differences.push({
        surface: "event",
        name: "marker",
        a: arrived[0] ? "marker event arrived" : `no task-status-changed event for marker task ${markerA} within 15 s`,
        b: arrived[1] ? "marker event arrived" : `no task-status-changed event for marker task ${markerB} within 15 s`,
      });
    }
    const inventory = readInventory();
    const commands = bindingsCommands();
    const toolsA = toolNames(outcome.a[outcome.steps.findIndex((step) => step.name === "tools/list")]);
    if (canonical(commands) !== canonical(inventory.commands) || canonical(toolsA) !== canonical(inventory.tools)) {
      differences.push({
        surface: "inventory",
        name: "inventory.json",
        a: `bindings.rs ${commands.length} commands, A tools/list ${toolsA.length} tools`,
        b: `inventory.json ${inventory.commands.length} commands, ${inventory.tools.length} tools; run \`inventory --write\` and cover the new ones in scenario.ts`,
      });
    }
    const missingCommands = inventory.commands.filter((command) => !outcome.called.rpc.has(command));
    const missingTools = inventory.tools.filter((tool) => !outcome.called.tools.has(tool));
    if (missingCommands.length > 0 || missingTools.length > 0) {
      differences.push({ surface: "coverage", name: "scenario.ts", a: `commands not called: ${missingCommands.join(", ") || "none"}`, b: `tools not called: ${missingTools.join(", ") || "none"}` });
    }
    differences.push(...compareReplies(outcome, na, nb));
    differences.push(...compareEvents(eventsA.events, eventsB.events, na, nb));
    const dump = compareDumps(path.join(dirA, DATABASE_FILE), path.join(dirB, DATABASE_FILE), na, nb);
    differences.push(...dump.differences);

    writeFileSync(
      path.join(out, "steps.jsonl"),
      outcome.steps
        .map((step, i) => JSON.stringify({ step: step.name, a: normalizeValue(na, outcome.a[i]), b: normalizeValue(nb, outcome.b[i]) }))
        .join("\n") + "\n",
    );
    writeFileSync(path.join(out, "differences.json"), JSON.stringify(differences, null, 2));
    printDifferences(differences);
    const coveredCommands = inventory.commands.length - missingCommands.length;
    const coveredTools = inventory.tools.length - missingTools.length;
    console.log(
      `\nreplay: ${outcome.steps.length} steps; commands ${coveredCommands}/${inventory.commands.length}, tools ${coveredTools}/${inventory.tools.length}; ` +
        `events A ${eventsA.events.length} B ${eventsB.events.length}; dump ${dump.lines} lines; ${differences.length} differences`,
    );
    console.log(`report: ${out}`);
    return differences.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`A log:\n${a.output()}`);
    if (b !== undefined) console.error(`B log:\n${b.output()}`);
    throw error;
  } finally {
    await a.stop();
    await b?.stop();
    if (options.keep !== true) rmSync(work, { recursive: true, force: true });
  }
}

const markerSteps: Step[] = [
  { name: "create_task#marker", call: (own) => ({ rpc: "create_task", args: { task: { workspaceId: (data(own.get("create_workspace#a")) as { id: number }).id, taskType: "chore", title: "Parity marker", description: "", estimate: null, dueDate: null, criteria: [] } } }) },
  { name: "start_task#marker", call: (own) => ({ rpc: "start_task", args: { id: (data(own.get("create_task#marker")) as { id: number }).id, reason: null, refs: null } }) },
  marker,
];

/** One shadow round: both servers on a fresh read-only copy of the live database, the reads compared. */
async function shadowRound(live: string, reference: ServerSpec, candidate: ServerSpec, work: string): Promise<{ steps: number; differences: Difference[] }> {
  const from = Math.floor(Date.now() / 1000);
  const [dirA, dirB] = prepareCopies(work, live, ["reference", "candidate"]);
  const env = harnessEnv(work);
  const a = await startServer(reference, dirA, env);
  let b: RunningServer | undefined;
  try {
    b = await startServer(candidate, dirB, env);
    const steps = await readSteps(a);
    const outcome = await runBoth(steps, a, b);
    await Promise.all([a.stop(), b.stop()]);
    const to = Math.floor(Date.now() / 1000);
    const na = normalizerFor(a, from, to);
    const nb = normalizerFor(b, from, to);
    const differences = compareReplies(outcome, na, nb);
    differences.push(...compareDumps(path.join(dirA, DATABASE_FILE), path.join(dirB, DATABASE_FILE), na, nb).differences);
    return { steps: steps.length, differences };
  } finally {
    await a.stop();
    await b?.stop();
  }
}

async function shadow(options: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof options.live !== "string") throw new Error("shadow needs --live FILE, the live database");
  const live = options.live;
  const rounds = Number(options.rounds ?? 1);
  const interval = Number(options.interval ?? 3600);
  const out = typeof options.out === "string" ? options.out : mkdtempSync(path.join(tmpdir(), "toodo-shadow-report-"));
  mkdirSync(out, { recursive: true });
  let failed = 0;
  for (let round = 1; round <= rounds; round++) {
    const work = mkdtempSync(path.join(tmpdir(), "toodo-shadow-"));
    try {
      const at = new Date().toISOString();
      const result = await shadowRound(live, spec("reference", options.reference as string | undefined), spec("candidate", options.candidate as string | undefined), work);
      if (result.differences.length > 0) failed++;
      appendFileSync(
        path.join(out, "shadow.jsonl"),
        JSON.stringify({ round, at, steps: result.steps, differences: result.differences.map((d) => `${d.surface} ${d.name}`) }) + "\n",
      );
      writeFileSync(path.join(out, `round-${round}.json`), JSON.stringify(result.differences, null, 2));
      printDifferences(result.differences, 10);
      console.log(`shadow round ${round}/${rounds} at ${at}: ${result.steps} reads; ${result.differences.length} differences`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    // The pause between rounds is the schedule itself, not a wait for some state.
    if (round < rounds) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
  console.log(`shadow: ${rounds} rounds, ${failed} with differences; log: ${path.join(out, "shadow.jsonl")}`);
  return failed === 0 ? 0 : 1;
}

async function rustCheck(options: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof options.db !== "string") throw new Error("rust-check needs --db FILE, the database to copy");
  const work = mkdtempSync(path.join(tmpdir(), "toodo-rust-check-"));
  try {
    let dir: string;
    try {
      [dir] = prepareCopies(work, options.db, ["data"]);
    } catch (error) {
      console.log(`rust-check: FAIL, the database cannot be copied: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const copy = path.join(dir, DATABASE_FILE);
    const before = userVersion(copy);
    let server: RunningServer;
    try {
      server = await startServer(spec("rust", options.bin as string | undefined), dir, harnessEnv(work));
    } catch (error) {
      console.log(`rust-check: FAIL, the server did not start on the copy (schema version ${before})`);
      console.log(String(error).split("\n").slice(-15).join("\n"));
      return 1;
    }
    const failures: string[] = [];
    let count = 0;
    try {
      const own: Results = new Map();
      for (const step of await readSteps(server)) {
        const reply = await run(server, step.call(own));
        own.set(step.name, reply);
        count++;
        const body = reply.body as { jsonrpc?: string; error?: unknown; result?: { isError?: boolean } } | null;
        const mcpFailed = body?.jsonrpc !== undefined && (body.error != null || body.result?.isError === true);
        if (reply.status >= 400 || mcpFailed) {
          failures.push(`${step.name}: ${reply.status} ${canonical(reply.body).slice(0, 300)}`);
        }
      }
    } finally {
      await server.stop();
    }
    const integrity = integrityCheck(copy);
    const after = userVersion(copy);
    for (const failure of failures) console.log(`read failed: ${failure}`);
    console.log(`integrity_check: ${integrity.join("; ")}`);
    console.log(`schema version: ${before} before, ${after} after`);
    const ok = failures.length === 0 && integrity.length === 1 && integrity[0] === "ok";
    console.log(`rust-check: ${ok ? "PASS" : "FAIL"}, ${count} reads, ${failures.length} failed`);
    return ok ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function inventory(options: Record<string, string | boolean | undefined>): Promise<number> {
  const work = mkdtempSync(path.join(tmpdir(), "toodo-inventory-"));
  try {
    const [dir] = prepareCopies(work, undefined, ["data"]);
    const server = await startServer(spec("rust", options.bin as string | undefined), dir, harnessEnv(work));
    let tools: string[];
    try {
      tools = toolNames(await server.mcp("tools/list"));
    } finally {
      await server.stop();
    }
    const current: Inventory = { commands: bindingsCommands(), tools };
    const saved = readInventory();
    console.log(`bindings.rs: ${current.commands.length} commands (inventory ${saved.commands.length}); tools/list: ${tools.length} tools (inventory ${saved.tools.length})`);
    if (options.write === true) {
      writeFileSync(INVENTORY, JSON.stringify(current, null, 2) + "\n");
      console.log(`wrote ${INVENTORY}`);
      return 0;
    }
    const same = canonical(current) === canonical(saved);
    console.log(same ? "inventory is current" : "inventory differs; rerun with --write and cover the new entries in scenario.ts");
    return same ? 0 : 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    a: { type: "string" },
    b: { type: "string" },
    db: { type: "string" },
    out: { type: "string" },
    keep: { type: "boolean" },
    live: { type: "string" },
    reference: { type: "string" },
    candidate: { type: "string" },
    rounds: { type: "string" },
    interval: { type: "string" },
    bin: { type: "string" },
    write: { type: "boolean" },
  },
});

const commands: Record<string, (options: Record<string, string | boolean | undefined>) => Promise<number>> = {
  replay,
  shadow,
  "rust-check": rustCheck,
  inventory,
};
const command = commands[positionals[0] ?? ""];
if (command === undefined) {
  console.error("usage: node scripts/parity/parity.ts <replay|shadow|rust-check|inventory> [options]; see docs/parity.md");
  process.exit(2);
}
process.exitCode = await command(values);

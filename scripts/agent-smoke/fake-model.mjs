// Contract-probe fake: an OpenAI-compatible chat API, a Gemini API, and a minimal MCP
// endpoint on one port. Every request is appended to requests.jsonl (path, auth present).
import { appendFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 0);
const logFile = process.argv[3];
const TOKEN = process.argv[4] ?? "probe-token";
const TODO_NAMES = ["todowrite", "write_todos", "TodoWrite", "todo_write", "todo"];

const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + "\n");
const sse = (chunks) =>
  new Response(chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

function openai(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1] ?? {};
  const tools = (body.tools ?? []).map((t) => t.function?.name);
  const todo = tools.find((n) => TODO_NAMES.includes(n));
  const toolAnswered = last.role === "tool";
  const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
  const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: body.model };
  let delta, finish;
  if (!toolAnswered && todo) {
    const args =
      todo === "write_todos"
        ? { todos: [{ description: "Probe step", status: "in_progress" }] }
        : { todos: [{ content: "Probe step", status: "in_progress", priority: "high", id: "1" }] };
    delta = { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: todo, arguments: JSON.stringify(args) } }] };
    finish = "tool_calls";
  } else {
    delta = { role: "assistant", content: "PROBE_OK" };
    finish = "stop";
  }
  if (!body.stream) {
    return Response.json({
      id: "c1", object: "chat.completion", created: 0, model: body.model, usage,
      choices: [{ index: 0, message: { role: "assistant", content: delta.content ?? null, tool_calls: delta.tool_calls?.map(({ index, ...t }) => t) }, finish_reason: finish }],
    });
  }
  return sse([
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...base, choices: [], usage },
    "[DONE]",
  ]);
}

function gemini(url, body) {
  const contents = body.contents ?? [];
  const last = contents[contents.length - 1] ?? { parts: [] };
  const answered = (last.parts ?? []).some((p) => p.functionResponse);
  const tools = (body.tools ?? []).flatMap((t) => (t.functionDeclarations ?? []).map((d) => d.name));
  const usageMetadata = { promptTokenCount: 11, candidatesTokenCount: 3, totalTokenCount: 14 };
  let parts;
  if (url.pathname.endsWith(":countTokens")) return Response.json({ totalTokens: 11 });
  if (!url.pathname.includes("streamGenerateContent")) {
    // Utility calls (routing, next-speaker checks, titles): a JSON answer fits each.
    parts = [{ text: JSON.stringify({ reasoning: "probe", model_choice: "flash", next_speaker: "user" }) }];
    return Response.json({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata });
  }
  if (!answered && tools.includes("write_todos")) {
    parts = [{ functionCall: { name: "write_todos", args: { todos: [{ description: "Probe step", status: "in_progress" }] } } }];
  } else {
    parts = [{ text: "PROBE_OK" }];
  }
  return sse([{ candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata, modelVersion: "probe" }]);
}

function mcp(body) {
  const reply = (result) => Response.json({ jsonrpc: "2.0", id: body.id, result });
  switch (body.method) {
    case "initialize":
      return reply({ protocolVersion: body.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0" } });
    case "tools/list":
      return reply({ tools: [] });
    default:
      return body.id === undefined ? new Response(null, { status: 202 }) : reply({});
  }
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const text = req.method === "POST" ? await req.text() : "";
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    const auth = req.headers.get("authorization") ?? req.headers.get("x-goog-api-key") ?? "";
    log({ method: req.method, path: url.pathname, bearerOk: auth === `Bearer ${TOKEN}`, authPresent: auth !== "", rpc: body.method, model: body.model, tools: (body.tools ?? []).length });
    if (url.pathname.startsWith("/mcp")) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      if (auth !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
      return mcp(body);
    }
    if (url.pathname.endsWith("/chat/completions")) return openai(body);
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "probe-model", object: "model" }] });
    if (url.pathname.includes("/models/")) return gemini(url, body);
    return new Response("not found", { status: 404 });
  },
});
console.log(`LISTENING ${server.port}`);

import { createInterface } from "node:readline";

let nextThread = 1;
let nextTurn = 1;
const threads = new Set();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
    return;
  }
  if (request.method === "thread/start") {
    if (request.params.model === "session-model" && request.params.config?.model_auto_compact_token_limit !== 100000) {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "session context config missing on thread/start" } });
      return;
    }
    const id = `thread-${nextThread++}`;
    threads.add(id);
    send({ jsonrpc: "2.0", id: request.id, result: { thread: { id } } });
    return;
  }
  if (request.method === "thread/resume") {
    if (request.params.model === "session-model" && request.params.config?.model_auto_compact_token_limit !== 100000) {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "session context config missing on thread/resume" } });
      return;
    }
    if (!threads.has(request.params.threadId)) {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "thread not found" } });
    } else {
      send({ jsonrpc: "2.0", id: request.id, result: { thread: { id: request.params.threadId } } });
    }
    return;
  }
  if (request.method === "thread/loaded/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { data: [...threads], nextCursor: null } });
    return;
  }
  if (request.method === "turn/start") {
    if (request.params.input?.[0]?.text === "session-config-check" && (request.params.model !== "session-model" || request.params.effort !== "high")) {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "session model or effort missing on turn/start" } });
      return;
    }
    if (request.params.input?.[0]?.text === "hello" && !request.params.input.some((item) => item.type === "localImage" && item.path === "/tmp/example.png")) {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "localImage input missing" } });
      return;
    }
    if (request.params.input?.[0]?.text === "output-schema-check" && request.params.outputSchema?.properties?.notify?.type !== "boolean") {
      send({ jsonrpc: "2.0", id: request.id, error: { message: "output schema missing on turn/start" } });
      return;
    }
    const turnId = `turn-${nextTurn++}`;
    const threadId = request.params.threadId;
    send({ jsonrpc: "2.0", id: request.id, result: { turn: { id: turnId } } });
    setTimeout(() => {
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "测试" } });
      send({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "成功" } });
      send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
    }, 15);
    return;
  }
  if (request.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: request.id, result: { ok: true } });
  }
});

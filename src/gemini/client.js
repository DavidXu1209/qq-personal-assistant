import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { handleQqMcpTool } from "../qq/mcp-actions.js";
import { prepareLiveConversationPrompt } from "../qq/live-conversation.js";
import { composeGeminiSystemPrompt, resolveGeminiPersonaOverride } from "./persona.js";
import { toGeminiSchema } from "./schema.js";
import { geminiToolDeclarations } from "./tools.js";

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_TOOL_ROUNDS = 16;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

export class GeminiResumeError extends Error {
  constructor(threadId, cause) {
    super(`Unable to resume persistent Gemini thread ${threadId}: ${cause?.message || cause}`);
    this.name = "GeminiResumeError";
    this.code = "THREAD_RESUME_FAILED";
    this.threadId = threadId;
    this.cause = cause;
  }
}

export class GeminiTurnCancelledError extends Error {
  constructor() {
    super("Gemini turn was cancelled");
    this.name = "GeminiTurnCancelledError";
    this.code = "CANCELLED";
  }
}

export function geminiApiKey(env = process.env) {
  return String(env.GEMINI_API_KEY || env.CODEX_REMOTE_CONTACT_GEMINI_API_KEY || "").trim();
}

export function mapGeminiEffort(value) {
  const effort = String(value || "low").trim().toLowerCase();
  if (effort === "medium") return "medium";
  if (effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
  return "low";
}

export function usableGeminiModel(model, fallback = GEMINI_DEFAULT_MODEL) {
  const value = String(model || "").trim().replace(/^models\//, "");
  return /^gemini-/i.test(value) ? value : fallback;
}

export class GeminiClient {
  constructor({
    apiKey,
    model = GEMINI_DEFAULT_MODEL,
    effort = "low",
    systemPrompt = "",
    timeoutMs = 10 * 60 * 1000,
    threadsDir,
    cwd = process.cwd(),
    apiBase = process.env.GEMINI_API_BASE || process.env.CODEX_REMOTE_CONTACT_GEMINI_API_BASE || GEMINI_API_BASE,
    fetch: fetchImpl = globalThis.fetch,
    env = process.env,
    personaOverride = null,
    readFile
  } = {}) {
    this.apiKey = apiKey == null ? geminiApiKey(env) : String(apiKey).trim();
    this.model = usableGeminiModel(model, GEMINI_DEFAULT_MODEL);
    this.effort = mapGeminiEffort(effort);
    this.personaOverride = personaOverride || resolveGeminiPersonaOverride(env, readFile ? { readFile } : {});
    this.baseSystemPrompt = "";
    this.systemPrompt = "";
    this.timeoutMs = timeoutMs;
    this.threadsDir = threadsDir || join(cwd, "runtime", "gemini-threads");
    this.apiBase = String(apiBase || GEMINI_API_BASE).replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.activeByThread = new Map();
    this.activeByTurn = new Map();
    this.activeByGroup = new Map();
    this.supportsSystemPrompt = true;
    this.supportsQqMcp = true;
    this.provider = "gemini-api";
    if (!this.apiKey) {
      console.warn("GEMINI_API_KEY is missing; Gemini turns cannot run. Create a key at https://aistudio.google.com/apikey");
    }
    this.setSystemPrompt(systemPrompt);
  }

  capabilities() {
    return {
      systemPrompt: true,
      qqMcp: true,
      deleteThread: true,
      persistentThreads: true,
      streaming: true
    };
  }

  setSystemPrompt(value) {
    this.baseSystemPrompt = String(value || "").trim();
    this.systemPrompt = composeGeminiSystemPrompt(this.baseSystemPrompt, this.personaOverride);
  }

  async startThread({ threadId = null } = {}) {
    const id = String(threadId || `gemini-${randomUUID()}`);
    await this.saveThread({ id, contents: [], updatedAt: new Date().toISOString() });
    return id;
  }

  async resumeThread(threadId) {
    const id = String(threadId || "");
    if (this.activeByThread.has(id)) throw new Error(`Gemini thread ${id} already has a running turn`);
    await this.loadThread(id);
    return id;
  }

  async runTurn({
    groupId, threadId, prompt, imagePaths = [], model = this.model, effort = this.effort,
    contextTokenLimit = null, outputSchema = null, qqToolContext = null, onDelta = null,
    prefetchQqMessages = true, turnTimeoutMs = this.timeoutMs
  }) {
    this.requireKey();
    const id = String(threadId || "");
    const target = String(groupId);
    if (!id) throw new Error("Gemini thread id is required");
    if (this.activeByThread.has(id)) throw new Error(`Gemini thread ${id} already has a running turn`);
    if (this.activeByGroup.has(target)) throw new Error(`QQ group ${target} already has a running turn`);
    const active = {
      groupId: target,
      threadId: id,
      turnId: `gemini-turn-${randomUUID()}`,
      onDelta,
      qqToolContext,
      mcpActions: [],
      cancelRequested: false,
      shuttingDown: false,
      timedOut: false,
      abort: new AbortController()
    };
    this.track(active);
    const timeout = setTimeout(() => {
      active.timedOut = true;
      active.abort.abort();
    }, Math.max(1, Number(turnTimeoutMs) || this.timeoutMs));
    timeout.unref?.();
    try {
      let turnPrompt = String(prompt || "");
      if (prefetchQqMessages !== false) turnPrompt = await prepareLiveConversationPrompt(qqToolContext, turnPrompt);
      this.throwIfStopped(active);
      const stored = await this.loadThread(id);
      const trimmed = trimContents(stored.contents, contextTokenLimit);
      const contents = [...trimmed.contents, { role: "user", parts: await userParts(turnPrompt, imagePaths) }];
      const declarations = toolDeclarationsFor(qqToolContext);
      let finalText = "";
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        this.throwIfStopped(active);
        const generated = await this.generate({
          active,
          model: usableGeminiModel(model, this.model),
          effort: mapGeminiEffort(effort || this.effort),
          contents,
          declarations,
          outputSchema: declarations.length ? null : outputSchema,
          threadId: id
        });
        contents.push({ role: "model", parts: generated.parts });
        const calls = generated.parts.filter((part) => part.functionCall);
        if (!calls.length) {
          finalText = visibleText(generated.parts);
          break;
        }
        if (round === MAX_TOOL_ROUNDS - 1) throw new Error("Gemini tool loop exceeded 16 rounds");
        const responses = [];
        for (const part of calls) {
          this.throwIfStopped(active);
          const call = part.functionCall;
          const result = await this.dispatchTool(active, call.name, callArgs(call));
          responses.push({
            functionResponse: {
              name: call.name,
              ...(call.id ? { id: call.id } : {}),
              response: { result: toolResultText(result), isError: Boolean(result?.isError) }
            }
          });
        }
        contents.push({ role: "user", parts: responses });
      }
      assertToolCompletion(active);
      await this.saveThread({ id, contents, updatedAt: new Date().toISOString() });
      return {
        text: replyText(active, finalText),
        threadId: id,
        turnId: active.turnId,
        compacted: trimmed.compacted
      };
    } catch (error) {
      throw this.normalizeError(active, error);
    } finally {
      clearTimeout(timeout);
      this.untrack(active);
    }
  }

  async interruptGroup(groupId) {
    const active = this.activeByGroup.get(String(groupId));
    if (!active) return false;
    active.cancelRequested = true;
    active.abort.abort();
    return true;
  }

  activeGroups() {
    return [...this.activeByGroup.keys()];
  }

  async listModels() {
    this.requireKey();
    const models = [];
    let pageToken = "";
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`${this.apiBase}/models`);
      url.searchParams.set("pageSize", "100");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const payload = await this.requestJson(url, { method: "GET" });
      models.push(...(payload.models || []));
      pageToken = payload.nextPageToken || "";
      if (!pageToken) break;
    }
    return models
      .filter((item) => (item.supportedGenerationMethods || []).includes("generateContent") || !(item.supportedGenerationMethods || []).length)
      .map((item) => geminiCatalogEntry(item, this.model));
  }

  async listLoadedThreads() {
    const names = await readdir(this.threadsDir).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const ids = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.threadsDir, name), "utf8"));
        if (parsed?.id) ids.push(String(parsed.id));
      } catch {
        // A torn write is ignored until the next successful turn.
      }
    }
    return ids;
  }

  async deleteThread(threadId) {
    const id = String(threadId || "");
    if (!id) throw new Error("Gemini thread id is required");
    if (this.activeByThread.has(id)) throw new Error(`Gemini thread ${id} still has a running turn`);
    await rm(threadPath(this.threadsDir, id), { force: true });
    return { deleted: true };
  }

  async close() {
    for (const active of [...this.activeByTurn.values()]) {
      active.shuttingDown = true;
      active.abort.abort();
    }
  }

  requireKey() {
    if (this.apiKey) return;
    throw new Error("GEMINI_API_KEY is required when CODEX_REMOTE_CONTACT_ENGINE=gemini. Create one at https://aistudio.google.com/apikey and keep it out of Git.");
  }

  async generate({ active, model, effort, contents, declarations, outputSchema, threadId }) {
    const system = ephemeralThread(threadId) ? "" : this.systemPrompt;
    const generationConfig = { thinkingConfig: { thinkingLevel: effort } };
    if (outputSchema && typeof outputSchema === "object") {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseSchema = toGeminiSchema(outputSchema);
    }
    const body = {
      contents,
      generationConfig,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {})
    };
    const url = new URL(`${this.apiBase}/models/${encodeURIComponent(model)}:streamGenerateContent`);
    url.searchParams.set("alt", "sse");
    const response = await this.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: active.abort.signal
    });
    return readGenerateStream(response, active);
  }

  async dispatchTool(active, name, args) {
    let result;
    try {
      if (active.qqToolContext?.liveMode) {
        result = await active.qqToolContext.liveTool(name, args, active);
      } else if (["read_forward_messages", "read_link"].includes(name) && active.qqToolContext?.messageReader) {
        result = active.qqToolContext.sourceReadCalled
          ? await active.qqToolContext.messageReader.callTool(name, args, {
            shouldStop: () => active.cancelRequested || active.qqToolContext.canRead?.() === false
          })
          : { isError: true, content: [{ type: "text", text: "请先调用 read_source_messages 读取本轮唯一通知来源。" }] };
      } else {
        result = handleQqMcpTool({ name, args, context: active.qqToolContext, queued: active.mcpActions });
      }
    } catch (error) {
      if (active.cancelRequested || active.shuttingDown) throw error;
      result = { isError: true, content: [{ type: "text", text: String(error?.message || error) }] };
    }
    if (!active.qqToolContext?.liveMode && !result?.isError && name === "send_message") {
      const queued = active.mcpActions.find((action) => action.kind === "message");
      if (queued) active.onDelta?.(queued.text, queued.text);
    }
    return result;
  }

  async requestJson(url, options) {
    const response = await this.request(url, options);
    return response.json();
  }

  async request(url, options) {
    this.requireKey();
    const headers = { ...(options.headers || {}), "x-goog-api-key": this.apiKey };
    let response;
    try {
      response = await this.fetch(url, { ...options, headers, redirect: "error" });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error(`Gemini API request failed: ${redact(error?.message || error, this.apiKey)}`);
    }
    if (!response.ok) {
      const detail = redact(await response.text().catch(() => ""), this.apiKey).slice(0, 500);
      throw new Error(`Gemini API ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response;
  }

  track(active) {
    this.activeByThread.set(active.threadId, active);
    this.activeByTurn.set(active.turnId, active);
    this.activeByGroup.set(active.groupId, active);
  }

  untrack(active) {
    if (this.activeByTurn.get(active.turnId) !== active) return;
    this.activeByTurn.delete(active.turnId);
    this.activeByThread.delete(active.threadId);
    this.activeByGroup.delete(active.groupId);
  }

  throwIfStopped(active) {
    if (active.shuttingDown) throw new Error("Gemini client is shutting down");
    if (active.cancelRequested) throw new GeminiTurnCancelledError();
    if (active.timedOut) throw new Error("Gemini 长时间无进展；已中断本轮，待处理消息仍保留");
  }

  normalizeError(active, error) {
    if (active.shuttingDown) return new Error("Gemini client is shutting down");
    if (active.cancelRequested || error instanceof GeminiTurnCancelledError) return new GeminiTurnCancelledError();
    if (active.timedOut) return new Error("Gemini 长时间无进展；已中断本轮，待处理消息仍保留");
    if (error?.name === "AbortError") return new Error("Gemini API request failed: aborted");
    return error;
  }

  async loadThread(id) {
    try {
      const parsed = JSON.parse(await readFile(threadPath(this.threadsDir, id), "utf8"));
      if (!parsed || !Array.isArray(parsed.contents) || String(parsed.id || "") !== String(id)) {
        throw new Error("thread file is unreadable");
      }
      return parsed;
    } catch (error) {
      throw new GeminiResumeError(id, error);
    }
  }

  async saveThread(thread) {
    await mkdir(this.threadsDir, { recursive: true });
    const path = threadPath(this.threadsDir, thread.id);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ id: thread.id, contents: thread.contents, updatedAt: thread.updatedAt }), "utf8");
    await rename(temporary, path);
  }
}

function geminiCatalogEntry(item, selected) {
  const model = String(item.name || item.model || "").replace(/^models\//, "");
  const efforts = [
    ["low", "更快，适合聊天、摘要和事项提取"],
    ["medium", "平衡推理"],
    ["high", "更深推理，首字更慢、用量更高"]
  ];
  return {
    model,
    displayName: String(item.displayName || model),
    description: String(item.description || ""),
    hidden: false,
    isDefault: model === selected,
    defaultReasoningEffort: "low",
    reasoningCapabilitySource: "gemini-api",
    supportedReasoningEfforts: efforts.map(([reasoningEffort, description]) => ({ reasoningEffort, description }))
  };
}

function toolDeclarationsFor(context) {
  if (!context?.liveMode && !context?.requireSourceRead) return [];
  return geminiToolDeclarations({ sourceOnly: Boolean(context.requireSourceRead) && !context.liveMode });
}

function ephemeralThread(threadId) {
  return /^(?:sticker-(?:label|prune)|persona-style)-/u.test(String(threadId || ""));
}

function assertToolCompletion(active) {
  const context = active.qqToolContext;
  if (context?.requireRead && !context.readCalled) {
    throw new Error("Gemini did not read the current QQ messages; pending messages were retained");
  }
  if (context?.requireSourceRead && !context.sourceReadCalled) {
    throw new Error("Gemini did not read the subscribed source group through MCP; source messages were retained");
  }
  if (context?.failed) {
    throw new Error("A live QQ action failed; pending messages and delivery receipts were retained");
  }
}

function replyText(active, finalText) {
  const queued = (active.mcpActions || []).find((action) => action.kind === "message");
  const text = queued ? queued.text : finalText;
  const directives = (active.mcpActions || [])
    .map((action) => action.directive)
    .filter((directive) => directive && !String(text || "").includes(directive));
  return [text, ...directives].filter(Boolean).join("\n").trim();
}

function callArgs(call) {
  const raw = call?.args ?? {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function toolResultText(result) {
  return (result?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n") || (result?.isError ? "工具调用失败" : "ok");
}

function visibleText(parts) {
  return (parts || []).filter((part) => !part.thought && !part.functionCall && typeof part.text === "string").map((part) => part.text).join("");
}

function trimContents(contents, contextTokenLimit) {
  const numeric = Number(contextTokenLimit);
  const budget = Number.isFinite(numeric) && numeric > 0 ? numeric : 200_000;
  const maxChars = budget * 4;
  const turns = [];
  let current = [];
  for (const message of contents || []) {
    const startsTurn = message?.role === "user" && (message.parts || []).some((part) => part.text || part.inlineData);
    if (startsTurn && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) turns.push(current);
  let compacted = false;
  const size = () => JSON.stringify(turns.flat()).length;
  while (turns.length && size() > maxChars) {
    turns.shift();
    compacted = true;
  }
  return { contents: turns.flat(), compacted };
}

async function userParts(prompt, imagePaths) {
  const parts = [{ text: String(prompt || "") }];
  for (const path of imagePaths || []) {
    const bytes = await readFile(path);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Gemini image is larger than ${MAX_IMAGE_BYTES} bytes`);
    const mimeType = IMAGE_MIME[extname(path).toLowerCase()] || "application/octet-stream";
    parts.push({ inlineData: { mimeType, data: bytes.toString("base64") } });
  }
  return parts;
}

async function readGenerateStream(response, active) {
  const type = String(response.headers?.get?.("content-type") || "");
  if (type.includes("application/json") && !type.includes("event-stream")) {
    const payload = await response.json();
    return consumeGenerateChunks(Array.isArray(payload) ? payload : [payload], active);
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("Gemini API returned an empty stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;
  const chunks = [];
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    received += step.value.byteLength;
    if (received > MAX_RESPONSE_BYTES) throw new Error("Gemini API response is too large");
    buffer += decoder.decode(step.value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let split = buffer.indexOf("\n\n");
    while (split >= 0) {
      const raw = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const parsed = parseSseEvent(raw);
      if (parsed) chunks.push(parsed);
      split = buffer.indexOf("\n\n");
    }
  }
  const tail = parseSseEvent(buffer);
  if (tail) chunks.push(tail);
  return consumeGenerateChunks(chunks, active);
}

function parseSseEvent(raw) {
  const data = String(raw || "")
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data);
}

function consumeGenerateChunks(chunks, active) {
  const parts = [];
  let streamed = "";
  for (const chunk of chunks) {
    if (chunk.error) throw new Error(`Gemini API ${chunk.error.code || chunk.error.status || ""}: ${chunk.error.message || "request failed"}`.trim());
    if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini blocked the prompt (${chunk.promptFeedback.blockReason})`);
    const candidate = chunk.candidates?.[0];
    if (!candidate) continue;
    for (const part of candidate.content?.parts || []) appendPart(parts, part);
    const text = visibleText(parts);
    if (text.length > streamed.length && text.startsWith(streamed)) {
      const delta = text.slice(streamed.length);
      streamed = text;
      if (!(active.mcpActions || []).some((action) => action.kind === "message")) active.onDelta?.(delta, streamed);
    }
    const reason = candidate.finishReason;
    if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(reason) && !visibleText(parts) && !parts.some((part) => part.functionCall)) {
      throw new Error(`Gemini blocked the response (${reason})`);
    }
  }
  if (!parts.length) throw new Error("Gemini API returned no content");
  return { parts };
}

function appendPart(parts, part) {
  if (!part || typeof part !== "object") return;
  if (part.functionCall || part.thoughtSignature || part.thought) {
    parts.push(structuredClone(part));
    return;
  }
  if (typeof part.text !== "string") return;
  const last = parts.at(-1);
  if (last && typeof last.text === "string" && !last.functionCall && !last.thoughtSignature && !last.thought) last.text += part.text;
  else parts.push({ text: part.text });
}

function threadPath(dir, id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  if (!safe || safe === "." || safe === "..") throw new Error("Gemini thread id is invalid");
  return join(dir, `${safe}.json`);
}

function redact(value, secret) {
  const text = String(value || "");
  return secret ? text.split(secret).join("[redacted]") : text;
}

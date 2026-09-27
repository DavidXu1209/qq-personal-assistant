import { spawn } from "node:child_process";

export class CodexResumeError extends Error {
  constructor(threadId, cause) {
    super(`Unable to resume persistent Codex thread ${threadId}: ${cause?.message || cause}`);
    this.name = "CodexResumeError";
    this.code = "THREAD_RESUME_FAILED";
    this.threadId = threadId;
    this.cause = cause;
  }
}

export class CodexTurnCancelledError extends Error {
  constructor() {
    super("Codex turn was cancelled");
    this.name = "CodexTurnCancelledError";
    this.code = "CANCELLED";
  }
}

export class CodexClient {
  constructor({ executable, executableArgs = [], cwd, model, effort, timeoutMs = 10 * 60 * 1000, env = process.env } = {}) {
    this.executable = executable;
    this.executableArgs = executableArgs;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.timeoutMs = timeoutMs;
    this.env = env;
    this.child = null;
    this.startPromise = null;
    this.buffer = "";
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.activeByThread = new Map();
    this.activeByTurn = new Map();
    this.activeByGroup = new Map();
    this.recentRuntimeDiagnostic = null;
  }

  async ensureProcess() {
    if (this.child && this.child.exitCode == null) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    this.buffer = "";
    const child = spawn(this.executable, [...this.executableArgs, "--search", "app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      env: { ...this.env, CODEX_REMOTE_CONTACT_QQ_AGENT_MODE: "1" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const message = String(chunk || "").trim();
      if (!message) return;
      this.captureRuntimeDiagnostic(message);
      console.warn(`Codex app-server: ${message.slice(-2000)}`);
    });
    child.on("error", (error) => this.handleProcessFailure(error));
    child.on("close", (code, signal) => {
      this.handleProcessFailure(new Error(`Codex app-server exited${code == null ? "" : ` with ${code}`}${signal ? ` (${signal})` : ""}`));
      this.child = null;
    });
    await this.request("initialize", {
      clientInfo: {
        name: "codex-remote-contact",
        title: "QQ Persistent Group Agent Gateway",
        version: "0.2.0"
      }
    }, 30_000);
  }

  async startThread({ model = this.model, contextTokenLimit = null } = {}) {
    await this.ensureProcess();
    const response = await this.request("thread/start", {
      cwd: this.cwd,
      model,
      config: threadConfig(contextTokenLimit),
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false
    });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("Codex app-server did not return a thread id");
    return String(threadId);
  }

  async resumeThread(threadId, { threadSandbox = "read-only", model = this.model, contextTokenLimit = null } = {}) {
    await this.ensureProcess();
    try {
      await this.request("thread/resume", {
        threadId,
        cwd: this.cwd,
        model,
        config: threadConfig(contextTokenLimit),
        approvalPolicy: "never",
        sandbox: threadSandbox,
        excludeTurns: true
      });
    } catch (error) {
      throw new CodexResumeError(threadId, error);
    }
    return threadId;
  }

  async runTurn({
    groupId, threadId, prompt, imagePaths = [], turnSandbox = { type: "readOnly" },
    model = this.model, effort = this.effort, cwd = null, outputSchema = null, onDelta = null
  }) {
    await this.ensureProcess();
    if (this.activeByThread.has(threadId)) throw new Error(`Codex thread ${threadId} already has a running turn`);
    if (this.activeByGroup.has(String(groupId))) throw new Error(`QQ group ${groupId} already has a running turn`);
    const response = await this.request("turn/start", {
      threadId,
      input: [
        { type: "text", text: prompt },
        ...imagePaths.map((path) => ({ type: "localImage", path }))
      ],
      model,
      effort,
      approvalPolicy: "never",
      sandboxPolicy: turnSandbox,
      ...(outputSchema ? { outputSchema } : {}),
      ...(cwd ? { cwd } : {})
    });
    const turnId = response?.turn?.id;
    if (!turnId) throw new Error("Codex app-server did not return a turn id");

    return new Promise((resolve, reject) => {
      const active = {
        groupId: String(groupId),
        threadId: String(threadId),
        turnId: String(turnId),
        text: "",
        onDelta,
        resolve,
        reject,
        compacted: false,
        cancelRequested: false,
        timeout: null
      };
      active.timeout = setTimeout(() => {
        if (!this.activeByTurn.has(active.turnId)) return;
        this.finishTurn(active, new Error("Codex turn timed out"));
        this.child?.kill("SIGTERM");
      }, this.timeoutMs);
      this.activeByThread.set(active.threadId, active);
      this.activeByTurn.set(active.turnId, active);
      this.activeByGroup.set(active.groupId, active);
    });
  }

  async interruptGroup(groupId) {
    const active = this.activeByGroup.get(String(groupId));
    if (!active) return false;
    active.cancelRequested = true;
    try {
      await this.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId }, 10_000);
    } catch {
      this.child?.kill("SIGTERM");
      return true;
    }
    setTimeout(() => {
      if (!this.activeByTurn.has(active.turnId)) return;
      this.finishTurn(active, new CodexTurnCancelledError());
    }, 4000).unref?.();
    return true;
  }

  activeGroups() {
    return [...this.activeByGroup.keys()];
  }

  async listModels() {
    await this.ensureProcess();
    const models = [];
    let cursor = null;
    do {
      const response = await this.request("model/list", { cursor, includeHidden: false, limit: 100 }, 30_000);
      models.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
    } while (cursor);
    return models;
  }

  async listLoadedThreads() {
    await this.ensureProcess();
    const threadIds = [];
    let cursor = null;
    do {
      const response = await this.request("thread/loaded/list", { cursor, limit: 100 }, 30_000);
      threadIds.push(...(response?.data || []).map(String));
      cursor = response?.nextCursor || null;
    } while (cursor);
    return threadIds;
  }

  async close() {
    for (const active of this.activeByTurn.values()) this.finishTurn(active, new Error("Codex client is shutting down"));
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  request(method, params, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode != null) {
        reject(new Error("Codex app-server is not running"));
        return;
      }
      const id = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(String(id), { resolve, reject, timeout });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(String(id));
        reject(error);
      }
    });
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.id != null) {
      const pending = this.pendingRequests.get(String(message.id));
      if (pending) {
        this.pendingRequests.delete(String(message.id));
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message || "Codex app-server request failed"));
        else pending.resolve(message.result);
      }
    }

    if (message.method === "item/agentMessage/delta") {
      const params = message.params || {};
      const active = this.activeByTurn.get(String(params.turnId || ""));
      if (!active || String(params.threadId || "") !== active.threadId) return;
      const delta = String(params.delta || "");
      if (!delta) return;
      active.text += delta;
      active.onDelta?.(delta, active.text);
      return;
    }

    if (message.method === "item/completed" && message.params?.item?.type === "contextCompaction") {
      const active = this.activeByThread.get(String(message.params?.threadId || ""));
      if (active) active.compacted = true;
      return;
    }

    if (message.method === "turn/completed") {
      const params = message.params || {};
      const turnId = String(params.turn?.id || "");
      const active = this.activeByTurn.get(turnId);
      if (!active || String(params.threadId || "") !== active.threadId) return;
      if (active.cancelRequested) {
        this.finishTurn(active, new CodexTurnCancelledError());
        return;
      }
      const status = params.turn?.status;
      if (status && status !== "completed") {
        this.finishTurn(active, new Error(params.turn?.error?.message || `Codex turn ${status}`));
        return;
      }
      const completedText = extractAgentText(params.turn);
      this.finishTurn(active, null, {
        text: active.text || completedText,
        threadId: active.threadId,
        turnId: active.turnId,
        compacted: Boolean(active.compacted)
      });
      return;
    }

    if (message.method === "error") {
      const params = message.params || {};
      const threadId = String(params.threadId || "");
      const active = threadId ? this.activeByThread.get(threadId) : null;
      if (!active || (params.turnId && String(params.turnId) !== active.turnId)) return;
      // A retry notification is not a terminal turn failure. Releasing the
      // worker here lets new QQ messages start duplicate work in the same turn.
      if (params.willRetry === true) return;
      this.finishTurn(active, this.runtimeError(params.error?.message || params.message));
    }
  }

  captureRuntimeDiagnostic(message) {
    if (/Failed to run pre-sampling compact/i.test(message)) {
      this.recentRuntimeDiagnostic = {
        code: "THREAD_COMPACTION_FAILED",
        message: "Codex context compaction failed",
        recordedAt: Date.now()
      };
    }
  }

  runtimeError(message) {
    const fallback = String(message || "Codex app-server error");
    const diagnostic = this.recentRuntimeDiagnostic;
    if (diagnostic && Date.now() - diagnostic.recordedAt <= 15_000) {
      this.recentRuntimeDiagnostic = null;
      const error = new Error(diagnostic.message);
      error.code = diagnostic.code;
      return error;
    }
    const error = new Error(fallback);
    if (/thread-store conflict|already has an active writer/i.test(fallback)) error.code = "THREAD_WRITER_CONFLICT";
    return error;
  }

  finishTurn(active, error = null, value = null) {
    if (!active || !this.activeByTurn.has(active.turnId)) return;
    clearTimeout(active.timeout);
    this.activeByTurn.delete(active.turnId);
    this.activeByThread.delete(active.threadId);
    this.activeByGroup.delete(active.groupId);
    if (error) {
      if (active.compacted) error.contextCompacted = true;
      active.reject(error);
    }
    else active.resolve(value);
  }

  handleProcessFailure(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const active of [...this.activeByTurn.values()]) this.finishTurn(active, error);
  }
}

function extractAgentText(turn) {
  return (turn?.items || [])
    .filter((item) => item?.type === "agentMessage")
    .map((item) => String(item.text || ""))
    .join("");
}

function threadConfig(contextTokenLimit) {
  const limit = Number(contextTokenLimit || 0);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return {
    model_auto_compact_token_limit: Math.floor(limit),
    // A carried multimodal prefix can exceed small thresholds. Count growth
    // after it so a short budget does not cause compaction on every new turn.
    model_auto_compact_token_limit_scope: limit <= 64_000 ? "body_after_prefix" : "total"
  };
}

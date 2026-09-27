import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_ACTIONS = 1200;
const MAX_FEEDS = 1200;
const MAX_EVENTS = 30;

export class QzoneStore {
  constructor({ filePath, clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.state = defaultState();
    this.chain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = normalizeState(loaded);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.save();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  publicState() {
    const { targetType, targetId, autoPostEnabled, autoEngageEnabled, lastPostAt, lastScanAt, lastSeenFeedId, lastSeenFeedTimeMs, lastError, events } = this.state;
    return { targetType, targetId, autoPostEnabled, autoEngageEnabled, lastPostAt, lastScanAt, lastSeenFeedId, lastSeenFeedTimeMs, lastError, events: structuredClone(events) };
  }

  configure({ targetType = null, targetId = null, autoPostEnabled = false, autoEngageEnabled = false }) {
    return this.enqueue(async () => {
      const nextType = targetType === "group" || targetType === "private" ? targetType : null;
      const nextId = nextType ? String(targetId || "").trim() : null;
      if (nextType && !/^\d{5,14}$/.test(nextId)) throw new Error("QQ 空间绑定会话无效");
      this.state.targetType = nextType;
      this.state.targetId = nextId;
      this.state.autoPostEnabled = Boolean(nextId && autoPostEnabled);
      this.state.autoEngageEnabled = Boolean(nextId && autoEngageEnabled);
      this.state.lastError = null;
      await this.save();
      return this.publicState();
    });
  }

  claimAction(key, kind, detail = {}) {
    return this.enqueue(async () => {
      const id = String(key || "").trim();
      if (!id || this.state.actions[id]) return false;
      this.state.actions[id] = { kind, status: "attempted", at: this.nowIso(), ...detail };
      this.trim();
      await this.save();
      return true;
    });
  }

  finishAction(key, { status = "done", message = "", detail = {} } = {}) {
    return this.enqueue(async () => {
      const action = this.state.actions[String(key || "")];
      if (!action) return null;
      action.status = status;
      action.completedAt = this.nowIso();
      action.message = String(message || "").slice(0, 500);
      Object.assign(action, detail);
      this.state.events.unshift({ kind: action.kind, status, at: action.completedAt, message: action.message });
      this.state.events = this.state.events.slice(0, MAX_EVENTS);
      if (["post", "scheduled-post"].includes(action.kind) && status === "done") this.state.lastPostAt = action.completedAt;
      if (status === "failed") this.state.lastError = action.message;
      else if (status === "done") this.state.lastError = null;
      await this.save();
      return structuredClone(action);
    });
  }

  hasAction(key) {
    return Boolean(this.state.actions[String(key || "")]);
  }

  hasFeed(key) {
    return Boolean(this.state.feeds[String(key || "")]);
  }

  markFeeds(keys = [], { newestFeed = null } = {}) {
    return this.enqueue(async () => {
      for (const key of keys) {
        const id = String(key || "").trim();
        if (id) this.state.feeds[id] = this.nowIso();
      }
      if (newestFeed?.id && Number(newestFeed.timeMs) >= Number(this.state.lastSeenFeedTimeMs || 0)) {
        this.state.lastSeenFeedId = String(newestFeed.id);
        this.state.lastSeenFeedTimeMs = Number(newestFeed.timeMs) || null;
      }
      this.state.lastScanAt = this.nowIso();
      this.trim();
      await this.save();
    });
  }

  noteError(message) {
    return this.enqueue(async () => {
      this.state.lastError = String(message || "QQ 空间任务失败").slice(0, 500);
      this.state.events.unshift({ kind: "error", status: "failed", at: this.nowIso(), message: this.state.lastError });
      this.state.events = this.state.events.slice(0, MAX_EVENTS);
      await this.save();
    });
  }

  trim() {
    this.state.actions = latestEntries(this.state.actions, MAX_ACTIONS);
    this.state.feeds = latestEntries(this.state.feeds, MAX_FEEDS);
  }

  enqueue(operation) {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => {});
    return next;
  }

  async save() {
    this.state.updatedAt = this.nowIso();
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  nowIso() {
    return this.clock().toISOString();
  }
}

function defaultState() {
  return {
    version: 1, updatedAt: null,
    targetType: null, targetId: null,
    autoPostEnabled: false, autoEngageEnabled: false,
    lastPostAt: null, lastScanAt: null, lastSeenFeedId: null, lastSeenFeedTimeMs: null, lastError: null,
    actions: {}, feeds: {}, events: []
  };
}

function normalizeState(value) {
  const base = defaultState();
  const targetType = ["group", "private"].includes(value?.targetType) ? value.targetType : null;
  const targetId = targetType && /^\d{5,14}$/.test(String(value?.targetId || "")) ? String(value.targetId) : null;
  return {
    ...base,
    updatedAt: value?.updatedAt || null,
    targetType: targetId ? targetType : null,
    targetId,
    autoPostEnabled: Boolean(targetId && value?.autoPostEnabled),
    autoEngageEnabled: Boolean(targetId && value?.autoEngageEnabled),
    lastPostAt: value?.lastPostAt || null,
    lastScanAt: value?.lastScanAt || null,
    lastSeenFeedId: value?.lastSeenFeedId || null,
    lastSeenFeedTimeMs: Number(value?.lastSeenFeedTimeMs) || null,
    lastError: value?.lastError || null,
    actions: value?.actions && typeof value.actions === "object" ? latestEntries(value.actions, MAX_ACTIONS) : {},
    feeds: value?.feeds && typeof value.feeds === "object" ? latestEntries(value.feeds, MAX_FEEDS) : {},
    events: Array.isArray(value?.events) ? value.events.slice(0, MAX_EVENTS) : []
  };
}

function latestEntries(record, limit) {
  return Object.fromEntries(Object.entries(record).slice(-limit));
}

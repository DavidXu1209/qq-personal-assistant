import { REPLY_FOLLOWUP_MS } from "../storage/session-store.js";

/** Keeps the gateway worker alive without keeping a model request alive. */
export class ConversationFollowup {
  constructor({ store, canRun, blocked, shouldYield = () => false, setLive, onEvent, targetType, durationMs = REPLY_FOLLOWUP_MS }) {
    Object.assign(this, { store, canRun, blocked, shouldYield, setLive, onEvent, targetType, durationMs });
    this.cancelled = new Set();
  }

  start(id) { this.cancelled.delete(String(id)); }

  async arm(id, context) {
    if (this.cancelled.has(String(id))) { await this.store.cancelReplyFollowup(id); return; }
    await this.store.armReplyFollowup(id, { afterSequence: context.lastReadSequence, durationMs: this.durationMs });
  }

  publishWaiting(id, patch = {}) {
    const state = this.store.snapshot(id);
    const window = state.replyFollowup;
    const observing = window && Date.parse(window.expiresAt) > this.store.clock().getTime();
    const status = this.cancelled.has(String(id)) ? "cancelled" : !this.canRun(id) ? "paused"
      : state.pendingTrigger ? "queued" : observing ? "waiting" : "completed";
    this.setLive(id, { ...patch, status, text: "", error: null, waitUntil: status === "waiting" ? window?.expiresAt || null : null });
  }

  publishQueued(id) {
    this.setLive(id, { status: "queued", text: "", waitUntil: null });
    this.onEvent({ type: "conversation-queued", targetType: this.targetType, targetId: String(id) });
  }

  async wait(id) {
    const window = this.store.snapshot(id).replyFollowup;
    if (!window) return false;
    this.publishWaiting(id);
    this.onEvent({ type: "conversation-waiting", targetType: this.targetType, targetId: String(id), waitUntil: window.expiresAt });
    const shouldStop = () => this.cancelled.has(String(id)) || !this.canRun(id) || this.blocked() || this.shouldYield(id)
      || !this.store.snapshot(id).replyFollowup || Boolean(this.store.snapshot(id).pendingTrigger)
      || this.store.clock().getTime() >= Date.parse(window.expiresAt);
    await this.store.waitForNewMessages(id, {
      afterSequence: window.afterSequence,
      timeoutMs: Math.max(0, Date.parse(window.expiresAt) - this.store.clock().getTime()), shouldStop
    });
    if (this.cancelled.has(String(id)) || !this.canRun(id)) {
      await this.store.cancelReplyFollowup(id);
      this.setLive(id, { status: this.cancelled.has(String(id)) ? "cancelled" : "paused", text: "", waitUntil: null });
      this.onEvent({ type: "conversation-stopped", targetType: this.targetType, targetId: String(id) });
      return false;
    }
    if (this.blocked()) {
      this.publishQueued(id);
      return false;
    }
    if (this.shouldYield(id)) {
      this.publishQueued(id);
      return false;
    }
    if (this.store.snapshot(id).pendingTrigger) return true;
    await this.store.cancelReplyFollowup(id);
    this.setLive(id, { status: "completed", text: "", waitUntil: null });
    this.onEvent({ type: "conversation-completed", targetType: this.targetType, targetId: String(id) });
    return false;
  }

  async cancel(id) {
    this.cancelled.add(String(id));
    await this.store.cancelReplyFollowup(id);
  }
}

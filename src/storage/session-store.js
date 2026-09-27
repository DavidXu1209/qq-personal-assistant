import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";

// A due subscription queues behind the active turn, then runs before later
// ordinary wake-ups. Delivery retries and explicit controls still take precedence.
export const TRIGGER_PRIORITY = Object.freeze({ scheduled: 1, followup: 3, message_count: 3, mention: 4, poke: 4, subscription_auto: 5, retry: 6, control: 7 });
export const REPLY_FOLLOWUP_MS = 120_000;
const LEGACY_EMPTY_REPLY_PLACEHOLDER = "这条消息暂时无法安全回复。";

export function rateLimitResumeAt(error) {
  const match = String(error || "").match(/\b429\b[\s\S]*?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC\+8/u);
  if (!match) return null;
  const timestamp = Date.parse(`${match[1]}T${match[2]}+08:00`);
  return Number.isFinite(timestamp) ? timestamp + 5_000 : null;
}

export class SessionStore {
  constructor({ filePath, clock = () => new Date(), defaultCodexConfig = null } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.defaultCodexConfig = normalizeCodexConfig(defaultCodexConfig);
    this.state = { version: 4, updatedAt: null, nextSequence: 1, groups: {} };
    this.saveChain = Promise.resolve();
    this.messageEvents = new EventEmitter();
  }

  async init({ allowedGroups = [], legacyContextPath = null } = {}) {
    await mkdir(dirname(this.filePath), { recursive: true });
    let loaded = null;
    try {
      loaded = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (loaded?.groups && typeof loaded.groups === "object") {
      this.state = normalizeState(loaded, this.defaultCodexConfig);
    } else if (legacyContextPath) {
      await this.importLegacyThreads(legacyContextPath);
    }
    for (const groupId of allowedGroups) this.ensureGroup(groupId);
    for (const group of Object.values(this.state.groups)) {
      if (Date.parse(group.replyFollowup?.expiresAt) <= this.clock().getTime()) group.replyFollowup = null;
      // The old count/clock triggers must not wake conversations after the policy changes.
      if (!group.failedDelivery && !group.busy && !group.processing
        && ["message_count", "scheduled"].includes(group.pendingTrigger?.reason)) group.pendingTrigger = null;
      if (group.busy || group.processing) {
        group.replyFollowup = null;
        const interruptedAuto = !group.failedDelivery && group.processing?.trigger?.reason === "subscription_auto";
        const interruptedStickerLabel = !group.failedDelivery && group.processing?.kind === "sticker_label";
        group.busy = false;
        group.processing = null;
        if (!interruptedStickerLabel) {
          group.pendingTrigger = strongerTrigger(group.pendingTrigger, {
            reason: interruptedAuto ? "subscription_auto" : "retry",
            priority: interruptedAuto ? TRIGGER_PRIORITY.subscription_auto : TRIGGER_PRIORITY.retry,
            requestedAt: this.nowIso(),
            messageId: null,
            sequence: null,
            trust: null
          });
        }
      }
      if (group.pendingTrigger?.reason === "sticker_label") group.pendingTrigger = null;
    }
    await this.save();
  }

  async importLegacyThreads(legacyContextPath) {
    let legacy = null;
    try {
      legacy = JSON.parse(await readFile(legacyContextPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return;
    }
    for (const [groupId, context] of Object.entries(legacy?.groups || {})) {
      const group = this.ensureGroup(groupId);
      if (!context?.threadId) continue;
      group.threadId = String(context.threadId);
      group.threadCreatedAt = context.summaryUpdatedAt || legacy.updatedAt || this.nowIso();
      group.lastActivityAt = context.summaryUpdatedAt || legacy.updatedAt || this.nowIso();
      group.bootstrapComplete = true;
      group.migratedFromLegacy = true;
    }
  }

  ensureGroup(groupId) {
    const id = String(groupId || "");
    if (!id) throw new Error("Group id is required");
    if (!this.state.groups[id]) this.state.groups[id] = createGroupState(id, this.defaultCodexConfig);
    return this.state.groups[id];
  }

  snapshot(groupId = null) {
    if (groupId == null) return structuredClone(this.state);
    return structuredClone(this.ensureGroup(groupId));
  }

  listGroups() {
    return Object.values(this.state.groups).map((group) => structuredClone(group));
  }

  rateLimitUntil(groupId) {
    return rateLimitResumeAt(this.ensureGroup(groupId).lastError);
  }

  async addConversation(groupId) {
    const group = this.ensureGroup(groupId);
    await this.save();
    return structuredClone(group);
  }

  referencedImages() {
    return Object.values(this.state.groups).flatMap((group) => group.pendingMessages.flatMap((message) => message.images || []));
  }

  async appendMessage(message) {
    const group = this.ensureGroup(message.groupId);
    const stored = {
      ...structuredClone(message),
      sequence: this.state.nextSequence++,
      receivedAt: this.nowIso()
    };
    delete stored.imageRefs;
    delete stored.followupWake;
    group.pendingMessages.push(stored);
    group.lastActivityAt = stored.timestamp || this.nowIso();
    let followupWake = false;
    const followup = group.replyFollowup;
    if (followup && Date.parse(stored.receivedAt) >= Date.parse(followup.expiresAt)) group.replyFollowup = null;
    else if (followup && Number(stored.sequence) > followup.afterSequence
      && Date.parse(stored.receivedAt) >= Date.parse(followup.startedAt) && stored.eventType !== "poke") {
      // Consume the window and queue the new round in the same durable write as
      // the message. A burst queues one round; later messages join that batch.
      group.replyFollowup = null;
      group.pendingTrigger = strongerTrigger(group.pendingTrigger, makeTrigger("followup", stored, this.nowIso()));
      followupWake = true;
    }
    await this.save();
    this.messageEvents.emit(String(message.groupId));
    return { ...structuredClone(stored), followupWake };
  }

  async armReplyFollowup(groupId, { deferredImageAfterSequence = null, afterSequence = null, durationMs = REPLY_FOLLOWUP_MS } = {}) {
    const group = this.ensureGroup(groupId);
    this.assertReplyEnabled(groupId);
    if (!group.busy || group.processing?.kind !== "agent") throw new Error("No live Agent conversation is active");
    const now = this.clock();
    group.replyFollowup = {
      startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + Math.max(0, Math.min(REPLY_FOLLOWUP_MS, durationMs))).toISOString(),
      afterSequence: afterSequence == null ? this.state.nextSequence - 1 : Number(afterSequence)
    };
    // Program-controlled completion also catches messages received while the
    // model was finishing, even when they did not @ the bot.
    const unread = afterSequence == null ? null : group.pendingMessages.find((message) =>
      Number(message.sequence) > Number(afterSequence) && message.eventType !== "poke");
    if (unread) {
      group.replyFollowup = null;
      group.pendingTrigger = strongerTrigger(group.pendingTrigger, makeTrigger("followup", unread, now.toISOString()));
    }
    // A new picture cannot be inserted into the current model request. If an
    // active wait saw it, queue a fresh visual round as soon as this one ends.
    if (deferredImageAfterSequence != null) {
      const image = group.pendingMessages.find((message) => Number(message.sequence) > Number(deferredImageAfterSequence)
        && (message.images || []).some((entry) => entry.localPath));
      if (image) {
        group.replyFollowup = null;
        group.pendingTrigger = strongerTrigger(group.pendingTrigger, makeTrigger("followup", image, now.toISOString()));
      }
    }
    await this.save();
    return structuredClone(group.replyFollowup);
  }

  async expireReplyFollowups() {
    let changed = false;
    for (const group of Object.values(this.state.groups)) {
      if (group.replyFollowup && Date.parse(group.replyFollowup.expiresAt) <= this.clock().getTime()) {
        group.replyFollowup = null;
        this.messageEvents.emit(String(group.groupId));
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  async cancelReplyFollowup(groupId) {
    const group = this.ensureGroup(groupId);
    group.replyFollowup = null;
    await this.save();
    this.messageEvents.emit(String(groupId));
  }

  waitForNewMessages(groupId, { afterSequence = 0, timeoutMs = 0, shouldStop = () => false } = {}) {
    const id = String(groupId);
    const hasNew = () => this.ensureGroup(id).pendingMessages.some((message) => Number(message.sequence) > afterSequence);
    if (hasNew() || shouldStop() || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let timeout;
      let cancellation;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearInterval(cancellation);
        this.messageEvents.removeListener(id, onChange);
        resolve();
      };
      const onChange = () => {
        try { if (hasNew() || shouldStop()) finish(); }
        catch { finish(); }
      };
      this.messageEvents.on(id, onChange);
      timeout = setTimeout(finish, timeoutMs);
      // Only cancellation is polled; message arrival wakes the listener directly.
      cancellation = setInterval(() => {
        try { if (shouldStop()) finish(); }
        catch { finish(); }
      }, 100);
      onChange(); // Close the check/subscribe race without missing an arrival.
    });
  }

  async requestTrigger(groupId, reason, meta = {}) {
    const group = this.ensureGroup(groupId);
    const candidate = makeTrigger(reason, meta, this.nowIso());
    group.pendingTrigger = strongerTrigger(group.pendingTrigger, candidate);
    await this.save();
    this.messageEvents.emit(String(groupId));
    return structuredClone(group.pendingTrigger);
  }

  async requestPeriodicTrigger(groupId, startupSequence = 0) {
    const group = this.ensureGroup(groupId);
    const processingCutoff = group.busy ? Number(group.processing?.cutoffSequence || 0) : 0;
    const lastChecked = Math.max(
      Number(group.periodicCheckedThroughSequence || 0),
      Number(group.deferredThroughSequence || 0),
      Number(startupSequence || 0),
      processingCutoff
    );
    const latest = [...group.pendingMessages].reverse().find((message) => Number(message.sequence) > lastChecked);
    if (!latest) return null;
    const sequence = Number(latest.sequence);
    const candidate = {
      reason: "scheduled",
      priority: TRIGGER_PRIORITY.scheduled,
      requestedAt: this.nowIso(),
      messageId: latest.messageId == null ? null : String(latest.messageId),
      sequence,
      senderId: latest.senderId == null ? null : String(latest.senderId),
      trust: latest.trust || null
    };
    group.periodicCheckedThroughSequence = sequence;
    group.pendingTrigger = strongerTrigger(group.pendingTrigger, candidate);
    await this.save();
    return structuredClone(group.pendingTrigger);
  }

  async beginWork(groupId) {
    const group = this.ensureGroup(groupId);
    if (this.rateLimitUntil(groupId) > this.clock().getTime()) return null;
    if (group.replyEnabled === false || group.busy || !group.pendingTrigger) return null;
    if (group.pendingMessages.length === 0 && group.pendingTrigger.reason !== "subscription_auto" && !group.failedDelivery) return null;
    const trigger = group.pendingTrigger;
    group.replyFollowup = null;
    group.pendingTrigger = null;
    group.busy = true;

    if (trigger.reason === "control" && trigger.sequence != null) {
      const commandMessage = group.pendingMessages.find((message) => message.sequence === trigger.sequence);
      if (!commandMessage) {
        group.busy = false;
        await this.save();
        return null;
      }
      group.processing = {
        kind: "control",
        replyRevision: group.replyRevision,
        cutoffSequence: commandMessage.sequence,
        processingUntilMessageId: commandMessage.messageId,
        trigger,
        startedAt: this.nowIso()
      };
      await this.save();
      return { kind: "control", trigger, messages: [structuredClone(commandMessage)], delivery: null };
    }

    if (group.failedDelivery) {
      const retained = Number(group.failedDelivery.cutoffSequence || 0) === 0
        || group.pendingMessages.some((message) => message.sequence <= group.failedDelivery.cutoffSequence);
      if (retained) {
        group.processing = {
          kind: "delivery",
          replyRevision: group.replyRevision,
          cutoffSequence: group.failedDelivery.cutoffSequence,
          processingUntilMessageId: group.failedDelivery.processingUntilMessageId,
          trigger,
          startedAt: this.nowIso()
        };
        await this.save();
        return { kind: "delivery", trigger, messages: [], delivery: structuredClone(group.failedDelivery) };
      }
      group.failedDelivery = null;
    }

    const cutoffSequence = group.pendingMessages.at(-1)?.sequence ?? 0;
    if (cutoffSequence === 0 && trigger.reason !== "subscription_auto") {
      group.busy = false;
      group.processing = null;
      await this.save();
      return null;
    }
    const messages = group.pendingMessages.filter((message) => message.sequence <= cutoffSequence);
    group.processing = {
      kind: "agent",
      replyRevision: group.replyRevision,
      cutoffSequence,
      processingUntilMessageId: messages.at(-1)?.messageId || null,
      trigger,
      startedAt: this.nowIso()
    };
    await this.save();
    return { kind: "agent", trigger: structuredClone(trigger), messages: structuredClone(messages), delivery: null };
  }

  async completeAgentWork(groupId, {
    reply, turnId, trigger, messages, bootstrapComplete = true, bootstrapRevision = null
  }) {
    const group = this.ensureGroup(groupId);
    const processing = group.processing;
    if (!processing || processing.kind !== "agent") throw new Error("No agent batch is active for this group");
    const processed = group.pendingMessages.filter((message) => message.sequence <= processing.cutoffSequence);
    group.pendingMessages = group.pendingMessages.filter((message) => message.sequence > processing.cutoffSequence);
    group.busy = false;
    group.processing = null;
    group.failedDelivery = null;
    group.liveSession = null;
    group.deferredThroughSequence = 0;
    group.lastError = null;
    group.resumeError = null;
    if (reply) {
      group.lastReply = String(reply);
      group.lastCompletedReply = {
        text: String(reply),
        completedAt: this.nowIso()
      };
    }
    group.lastActivityAt = this.nowIso();
    group.bootstrapComplete = Boolean(bootstrapComplete);
    if (bootstrapRevision != null) group.bootstrapRevision = Math.max(0, Math.floor(Number(bootstrapRevision) || 0));
    group.recentTurns.push({
      completedAt: this.nowIso(),
      turnId: turnId || null,
      trigger: trigger?.reason || null,
      messages: (messages || processed).map(compactMessage),
      reply: String(reply || ""),
      status: "completed"
    });
    group.recentTurns = group.recentTurns.slice(-50);
    await this.save();
    return processed;
  }

  async recordLiveActionSent(groupId, { kind, summary = "", observedSequence = 0, chatReply = true } = {}) {
    const group = this.ensureGroup(groupId);
    if (!group.busy || group.processing?.kind !== "agent") throw new Error("No live Agent conversation is active");
    // An in-flight OneBot request may succeed just as the reply switch turns off.
    // Preserve that receipt even though later actions and final cleanup are blocked.
    const latestObserved = Math.min(
      Math.max(0, Math.floor(Number(observedSequence) || 0)),
      Number(group.pendingMessages.at(-1)?.sequence || 0)
    );
    const live = group.liveSession || { lastSentSequence: 0, lastReply: "", actions: [] };
    if (chatReply) {
      live.lastSentSequence = Math.max(Number(live.lastSentSequence || 0), latestObserved);
      live.lastReply = String(summary || "").slice(0, 12000);
    }
    live.lastSentAt = this.nowIso();
    live.actions = [...(live.actions || []), {
      kind: String(kind || "action"), summary: String(summary || "").slice(0, 500), at: live.lastSentAt,
      observedSequence: latestObserved
    }].slice(-30);
    group.liveSession = live;
    group.lastActivityAt = live.lastSentAt;
    await this.save();
    return structuredClone(live);
  }

  async completeLiveConversation(groupId, {
    turnId, trigger, bootstrapComplete = true, bootstrapRevision = null,
    lastReadSequence = 0, consumeReadWithoutReply = false
  } = {}) {
    const group = this.ensureGroup(groupId);
    if (!group.busy || group.processing?.kind !== "agent") throw new Error("No live Agent conversation is active");
    this.assertReplyEnabled(groupId);
    const live = group.liveSession;
    const sentCutoff = Math.max(0, Number(live?.lastSentSequence || 0));
    const cutoff = consumeReadWithoutReply && sentCutoff === 0
      ? Math.max(0, Number(lastReadSequence || 0))
      : sentCutoff;
    const processed = group.pendingMessages.filter((message) => Number(message.sequence) <= cutoff);
    group.pendingMessages = group.pendingMessages.filter((message) => Number(message.sequence) > cutoff);
    if (cutoff && group.pendingTrigger?.sequence != null && Number(group.pendingTrigger.sequence) <= cutoff) {
      group.pendingTrigger = null;
    }
    if (!group.pendingMessages.length && group.pendingTrigger?.reason !== "subscription_auto") group.pendingTrigger = null;
    if (live?.lastReply) {
      group.lastReply = live.lastReply;
      group.lastCompletedReply = { text: live.lastReply, completedAt: this.nowIso() };
    }
    group.deferredThroughSequence = cutoff ? 0 : Math.max(
      Number(group.deferredThroughSequence || 0), Number(lastReadSequence || 0)
    );
    if (!cutoff && group.pendingTrigger?.sequence != null
      && Number(group.pendingTrigger.sequence) <= group.deferredThroughSequence) group.pendingTrigger = null;
    group.recentTurns.push({
      completedAt: this.nowIso(), turnId: turnId || null, trigger: trigger?.reason || null,
      messages: processed.map(compactMessage), reply: String(live?.lastReply || ""),
      status: "completed"
    });
    group.recentTurns = group.recentTurns.slice(-50);
    group.liveSession = null;
    group.busy = false;
    group.processing = null;
    group.failedDelivery = null;
    group.lastError = null;
    group.resumeError = null;
    group.lastActivityAt = this.nowIso();
    group.bootstrapComplete = Boolean(bootstrapComplete);
    if (bootstrapRevision != null) group.bootstrapRevision = Math.max(0, Math.floor(Number(bootstrapRevision) || 0));
    await this.save();
    return processed;
  }

  async applyStickerLabelResults(groupId, labels = [], { discardedIds = [] } = {}) {
    const group = this.ensureGroup(groupId);
    const labelById = new Map((labels || []).map((label) => [String(label?.id || ""), String(label?.usage || "")]));
    const discarded = new Set((discardedIds || []).map(String));
    for (const message of group.pendingMessages) {
      for (const image of message.images || []) {
        if (discarded.has(String(image.stickerId || ""))) {
          image.stickerLabel = "识别失败，未收录";
          image.stickerNeedsReview = false;
          image.stickerCandidate = false;
          continue;
        }
        const usage = labelById.get(String(image.stickerId || ""));
        if (!usage) continue;
        image.stickerLabel = usage;
        image.stickerNeedsReview = false;
        image.stickerCandidate = false;
      }
    }
    group.lastActivityAt = this.nowIso();
    await this.save();
  }

  async prepareDeliveryWork(groupId, {
    reply, displayReply = null, turnId, trigger, files = [], images = [], faces = [], stickers = [], pokes = [],
    subscriptionConsumptions = [], bootstrapComplete = true, bootstrapRevision = null, replyToMessageId = null
  }) {
    const group = this.ensureGroup(groupId);
    const processing = group.processing;
    if (!processing || processing.kind !== "agent") throw new Error("No agent batch is active for delivery preparation");
    group.failedDelivery = normalizeDelivery({
      reply: String(reply || ""),
      displayReply: String(displayReply || reply || ""),
      turnId: turnId || null,
      trigger: trigger?.reason || trigger || processing.trigger?.reason || null,
      cutoffSequence: processing.cutoffSequence,
      processingUntilMessageId: processing.processingUntilMessageId,
      bootstrapComplete: Boolean(bootstrapComplete),
      bootstrapRevision: Math.max(0, Math.floor(Number(bootstrapRevision) || 0)),
      replyToMessageId,
      textSent: false,
      files,
      images,
      faces,
      stickers,
      pokes,
      subscriptionConsumptions,
      createdAt: this.nowIso(),
      failedAt: null
    });
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryTextSent(groupId) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    group.failedDelivery.textSent = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryFileSent(groupId, index) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    const file = group.failedDelivery.files?.[Number(index)];
    if (!file) throw new Error(`Prepared QQ file ${index} does not exist`);
    file.delivered = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryImageSent(groupId, index) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    const image = group.failedDelivery.images?.[Number(index)];
    if (!image) throw new Error(`Prepared QQ image ${index} does not exist`);
    image.delivered = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryFaceSent(groupId, index) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    const face = group.failedDelivery.faces?.[Number(index)];
    if (!face) throw new Error(`Prepared QQ face ${index} does not exist`);
    face.delivered = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryStickerSent(groupId, index) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    const sticker = group.failedDelivery.stickers?.[Number(index)];
    if (!sticker) throw new Error(`Prepared QQ sticker ${index} does not exist`);
    sticker.delivered = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async markDeliveryPokeSent(groupId, index) {
    const group = this.ensureGroup(groupId);
    if (!group.failedDelivery) throw new Error("No prepared delivery exists for this group");
    const poke = group.failedDelivery.pokes?.[Number(index)];
    if (!poke) throw new Error(`Prepared QQ poke ${index} does not exist`);
    poke.delivered = true;
    await this.save();
    return structuredClone(group.failedDelivery);
  }

  async completeDeliveryWork(groupId) {
    const group = this.ensureGroup(groupId);
    const processing = group.processing;
    if (!processing || !["agent", "delivery"].includes(processing.kind)) {
      throw new Error("No prepared delivery is active for this group");
    }
    if (!group.failedDelivery) throw new Error("Prepared delivery state is missing");
    const bootstrapComplete = Boolean(group.failedDelivery?.bootstrapComplete);
    const bootstrapRevision = Math.max(0, Math.floor(Number(group.failedDelivery?.bootstrapRevision) || 0));
    const processed = group.pendingMessages.filter((message) => message.sequence <= processing.cutoffSequence);
    group.pendingMessages = group.pendingMessages.filter((message) => message.sequence > processing.cutoffSequence);
    if (group.failedDelivery) {
      group.recentTurns.push({
        completedAt: this.nowIso(),
        turnId: group.failedDelivery.turnId || null,
        trigger: group.failedDelivery.trigger || "retry",
        messages: processed.map(compactMessage),
        reply: group.failedDelivery.displayReply || group.failedDelivery.reply,
        status: processing.kind === "delivery" ? "delivered_after_retry" : "completed"
      });
      group.recentTurns = group.recentTurns.slice(-50);
      const completedReply = group.failedDelivery.displayReply || group.failedDelivery.reply;
      if (completedReply) {
        group.lastReply = completedReply;
        group.lastCompletedReply = {
          text: completedReply,
          completedAt: this.nowIso()
        };
      }
    }
    group.failedDelivery = null;
    group.liveSession = null;
    group.deferredThroughSequence = 0;
    group.busy = false;
    group.processing = null;
    group.lastError = null;
    group.resumeError = null;
    group.lastActivityAt = this.nowIso();
    group.bootstrapComplete = bootstrapComplete;
    group.bootstrapRevision = bootstrapRevision;
    await this.save();
    return processed;
  }

  async completeControlWork(groupId, sequence, { reply = null } = {}) {
    const group = this.ensureGroup(groupId);
    const processed = group.pendingMessages.filter((message) => message.sequence === sequence);
    group.pendingMessages = group.pendingMessages.filter((message) => message.sequence !== sequence);
    group.busy = false;
    group.processing = null;
    group.lastError = null;
    if (reply) group.lastReply = String(reply);
    group.lastActivityAt = this.nowIso();
    await this.save();
    return processed;
  }

  async failWork(groupId, error, { delivery = null } = {}) {
    const group = this.ensureGroup(groupId);
    const processing = group.processing;
    group.busy = false;
    group.processing = null;
    group.replyFollowup = null;
    const paused = group.replyEnabled === false || error?.code === "REPLY_DISABLED";
    group.lastError = paused ? null : String(error?.message || error).slice(0, 2000);
    if (paused && processing?.trigger && !group.pendingTrigger) {
      group.pendingTrigger = structuredClone(processing.trigger);
    }
    if (delivery && processing?.cutoffSequence != null) {
      group.failedDelivery = normalizeDelivery({
        ...group.failedDelivery,
        ...delivery,
        reply: String(delivery.reply ?? group.failedDelivery?.reply ?? ""),
        turnId: delivery.turnId || group.failedDelivery?.turnId || null,
        trigger: delivery.trigger || group.failedDelivery?.trigger || processing.trigger?.reason || null,
        cutoffSequence: processing.cutoffSequence,
        processingUntilMessageId: processing.processingUntilMessageId,
        bootstrapComplete: Boolean(delivery.bootstrapComplete ?? group.failedDelivery?.bootstrapComplete),
        bootstrapRevision: Math.max(0, Math.floor(Number(delivery.bootstrapRevision ?? group.failedDelivery?.bootstrapRevision) || 0)),
        failedAt: this.nowIso()
      });
    } else if (group.failedDelivery) {
      group.failedDelivery.failedAt = this.nowIso();
    }
    await this.save();
  }

  async setThread(groupId, threadId, {
    createdAt = null, bootstrapComplete = false, bootstrapRevision = 0
  } = {}) {
    const group = this.ensureGroup(groupId);
    group.threadId = String(threadId || "") || null;
    group.replyFollowup = null;
    group.threadCreatedAt = createdAt || this.nowIso();
    group.lastActivityAt = this.nowIso();
    group.bootstrapComplete = Boolean(bootstrapComplete);
    group.bootstrapRevision = Math.max(0, Math.floor(Number(bootstrapRevision) || 0));
    group.lastError = null;
    group.resumeError = null;
    await this.save();
  }

  async markBootstrapRequired(groupId) {
    const group = this.ensureGroup(groupId);
    group.bootstrapComplete = false;
    await this.save();
  }

  async markBootstrapComplete(groupId, revision) {
    const group = this.ensureGroup(groupId);
    group.bootstrapComplete = true;
    group.bootstrapRevision = Math.max(0, Math.floor(Number(revision) || 0));
    await this.save();
  }

  async setCodexConfig(groupId, config) {
    const group = this.ensureGroup(groupId);
    const previousModel = group.codexConfig.model;
    group.codexConfig = normalizeCodexConfig(config, this.defaultCodexConfig);
    if (previousModel !== group.codexConfig.model && this.rateLimitUntil(groupId)) group.lastError = null;
    await this.save();
    return structuredClone(group.codexConfig);
  }

  async setReplyEnabled(groupId, enabled) {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    const group = this.ensureGroup(groupId);
    if (group.replyEnabled !== enabled) group.replyRevision++;
    group.replyEnabled = enabled;
    if (!enabled) group.replyFollowup = null;
    await this.save();
    this.messageEvents.emit(String(groupId));
    return enabled;
  }

  assertReplyEnabled(groupId) {
    const group = this.ensureGroup(groupId);
    const stale = group.processing?.replyRevision != null && group.processing.replyRevision !== group.replyRevision;
    if (group.replyEnabled !== false && !stale) return;
    const error = new Error("本会话回复已关闭，消息继续记录");
    error.code = "REPLY_DISABLED";
    throw error;
  }

  async noteResumeError(groupId, error) {
    const group = this.ensureGroup(groupId);
    group.resumeError = String(error?.message || error).slice(0, 2000);
    group.lastError = `Codex thread resume failed: ${group.resumeError}`;
    await this.save();
  }

  async save() {
    this.state.updatedAt = this.nowIso();
    const body = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(tempPath, body, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    return this.saveChain;
  }

  nowIso() {
    return this.clock().toISOString();
  }
}

function createGroupState(groupId, defaultCodexConfig = null) {
  return {
    groupId,
    replyEnabled: true,
    replyRevision: 0,
    codexConfig: normalizeCodexConfig(defaultCodexConfig),
    threadId: null,
    threadCreatedAt: null,
    lastActivityAt: null,
    bootstrapComplete: false,
    bootstrapRevision: 0,
    migratedFromLegacy: false,
    pendingMessages: [],
    busy: false,
    pendingTrigger: null,
    processing: null,
    liveSession: null,
    replyFollowup: null,
    deferredThroughSequence: 0,
    periodicCheckedThroughSequence: 0,
    failedDelivery: null,
    lastError: null,
    resumeError: null,
    lastReply: "",
    lastCompletedReply: null,
    recentTurns: []
  };
}

function normalizeState(value, defaultCodexConfig = null) {
  const output = {
    version: 4,
    updatedAt: value.updatedAt || null,
    nextSequence: Math.max(1, Number(value.nextSequence || 1)),
    groups: {}
  };
  for (const [groupId, raw] of Object.entries(value.groups || {})) {
    const group = { ...createGroupState(groupId, defaultCodexConfig), ...raw, groupId };
    group.codexConfig = normalizeCodexConfig(raw.codexConfig, defaultCodexConfig);
    group.replyEnabled = raw.replyEnabled !== false;
    group.replyRevision = Math.max(0, Math.floor(Number(raw.replyRevision) || 0));
    const followup = raw.replyFollowup;
    const startedAt = Date.parse(followup?.startedAt);
    const expiresAt = Date.parse(followup?.expiresAt);
    group.replyFollowup = group.replyEnabled && Number.isFinite(startedAt) && Number.isFinite(expiresAt)
      && expiresAt > startedAt && expiresAt - startedAt <= REPLY_FOLLOWUP_MS
      ? { startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(expiresAt).toISOString(), afterSequence: Math.max(0, Number(followup.afterSequence) || 0) }
      : null;
    group.bootstrapRevision = Math.max(0, Math.floor(Number(raw.bootstrapRevision) || 0));
    group.pendingMessages = Array.isArray(raw.pendingMessages) ? raw.pendingMessages : [];
    group.recentTurns = Array.isArray(raw.recentTurns) ? raw.recentTurns.slice(-50) : [];
    group.failedDelivery = raw.failedDelivery ? normalizeDelivery(raw.failedDelivery) : null;
    group.liveSession = raw.liveSession && typeof raw.liveSession === "object" ? {
      lastSentSequence: Math.max(0, Number(raw.liveSession.lastSentSequence || 0)),
      lastReply: String(raw.liveSession.lastReply || "").slice(0, 12000),
      lastSentAt: raw.liveSession.lastSentAt || null,
      actions: Array.isArray(raw.liveSession.actions) ? raw.liveSession.actions.slice(-30) : []
    } : null;
    group.deferredThroughSequence = Math.max(0, Number(raw.deferredThroughSequence || 0));
    group.periodicCheckedThroughSequence = Math.max(0, Number(raw.periodicCheckedThroughSequence || 0));
    if (group.lastCompletedReply?.text === LEGACY_EMPTY_REPLY_PLACEHOLDER) group.lastCompletedReply = null;
    if (group.lastReply === LEGACY_EMPTY_REPLY_PLACEHOLDER) group.lastReply = "";
    if (!group.lastCompletedReply) {
      const latestCompletedTurn = [...group.recentTurns].reverse().find((turn) => (
        turn?.reply
        && turn.reply !== LEGACY_EMPTY_REPLY_PLACEHOLDER
        && turn?.completedAt
      ));
      if (latestCompletedTurn) {
        group.lastCompletedReply = {
          text: String(latestCompletedTurn.reply),
          completedAt: latestCompletedTurn.completedAt
        };
      }
    }
    if (group.lastError == null) group.resumeError = null;
    output.groups[groupId] = group;
    for (const message of group.pendingMessages) {
      output.nextSequence = Math.max(output.nextSequence, Number(message.sequence || 0) + 1);
    }
  }
  return output;
}

function normalizeCodexConfig(value, fallback = null) {
  const source = value && typeof value === "object" ? value : {};
  const defaults = fallback && typeof fallback === "object" ? fallback : {};
  const rawLimit = source.contextTokenLimit ?? defaults.contextTokenLimit ?? null;
  const configuredLimit = Number(rawLimit ?? 0);
  return {
    model: String(source.model || defaults.model || "").trim() || null,
    reasoningEffort: String(source.reasoningEffort || defaults.reasoningEffort || "").trim() || null,
    contextTokenLimit: rawLimit === "auto"
      ? "auto"
      : (Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : null),
    workingMode: ["agent", "plan", "ask"].includes(String(source.workingMode || defaults.workingMode || "agent"))
      ? String(source.workingMode || defaults.workingMode || "agent")
      : "agent",
    permissionMode: ["readOnly", "workspaceWrite", "dangerFullAccess"].includes(String(source.permissionMode || defaults.permissionMode || "workspaceWrite"))
      ? String(source.permissionMode || defaults.permissionMode || "workspaceWrite")
      : "workspaceWrite",
    calendarRemindersEnabled: source.calendarRemindersEnabled ?? defaults.calendarRemindersEnabled ?? true
  };
}

function normalizeDelivery(value) {
  return {
    reply: String(value?.reply || ""),
    displayReply: String(value?.displayReply || value?.reply || ""),
    turnId: value?.turnId || null,
    trigger: value?.trigger || null,
    cutoffSequence: Number(value?.cutoffSequence || 0),
    processingUntilMessageId: value?.processingUntilMessageId || null,
    bootstrapComplete: Boolean(value?.bootstrapComplete),
    bootstrapRevision: Math.max(0, Math.floor(Number(value?.bootstrapRevision) || 0)),
    replyToMessageId: value?.replyToMessageId || null,
    textSent: Boolean(value?.textSent),
    files: Array.isArray(value?.files)
      ? value.files.map((file) => ({
          sourcePath: String(file?.sourcePath || ""),
          name: String(file?.name || "file"),
          size: Number(file?.size || 0),
          delivered: Boolean(file?.delivered)
        }))
      : [],
    images: Array.isArray(value?.images)
      ? value.images.map((image) => ({
          sourcePath: String(image?.sourcePath || ""),
          name: String(image?.name || "image"),
          size: Number(image?.size || 0),
          mimeType: String(image?.mimeType || "application/octet-stream"),
          needsOptimization: Boolean(image?.needsOptimization),
          delivered: Boolean(image?.delivered)
        }))
      : [],
    faces: Array.isArray(value?.faces)
      ? value.faces.map((face) => ({
          id: Math.max(0, Math.floor(Number(face?.id) || 0)),
          name: String(face?.name || face?.id || "表情"),
          delivered: Boolean(face?.delivered)
        }))
      : [],
    stickers: Array.isArray(value?.stickers)
      ? value.stickers.map((sticker) => ({
          id: String(sticker?.id || ""),
          sourcePath: String(sticker?.sourcePath || ""),
          name: String(sticker?.name || "sticker"),
          size: Number(sticker?.size || 0),
          mimeType: String(sticker?.mimeType || "application/octet-stream"),
          usage: String(sticker?.usage || ""),
          marketEmojiId: sticker?.marketEmojiId ? String(sticker.marketEmojiId) : null,
          marketPackageId: Number(sticker?.marketPackageId || 0),
          marketKey: String(sticker?.marketKey || ""),
          qqSummary: String(sticker?.qqSummary || ""),
          delivered: Boolean(sticker?.delivered)
        })).filter((sticker) => sticker.id)
      : [],
    pokes: Array.isArray(value?.pokes)
      ? value.pokes.map((poke) => ({
          userId: String(poke?.userId || ""),
          delivered: Boolean(poke?.delivered)
        })).filter((poke) => /^\d{5,14}$/.test(poke.userId))
      : [],
    subscriptionConsumptions: Array.isArray(value?.subscriptionConsumptions)
      ? value.subscriptionConsumptions.map((context) => ({
          subscriptionId: String(context?.subscriptionId || ""),
          targetType: context?.targetType === "private" ? "private" : "group",
          targetId: String(context?.targetId || ""),
          sourceGroupId: String(context?.sourceGroupId || ""),
          collectionId: context?.collectionId || null,
          collectionIds: Array.isArray(context?.collectionIds) ? context.collectionIds.map(String) : [],
          notificationFingerprints: Array.isArray(context?.notificationFingerprints)
            ? context.notificationFingerprints.filter((fingerprint) => /^[a-f0-9]{64}$/.test(fingerprint)).slice(-256)
            : [],
          cutoffSequence: Number(context?.cutoffSequence || 0),
          messages: Array.isArray(context?.messages) ? context.messages.map(compactMessage) : []
        }))
      : [],
    createdAt: value?.createdAt || null,
    failedAt: value?.failedAt || null
  };
}

function makeTrigger(reason, meta, requestedAt) {
  return {
    reason, priority: TRIGGER_PRIORITY[reason] || 0, requestedAt,
    messageId: meta.messageId == null ? null : String(meta.messageId),
    sequence: Number.isFinite(Number(meta.sequence)) ? Number(meta.sequence) : null,
    senderId: meta.senderId == null ? null : String(meta.senderId),
    trust: meta.trust || null
  };
}

function strongerTrigger(current, candidate) {
  if (!current) return candidate;
  // Persisted triggers may have been written before priorities changed.
  // Compare by reason so an older, lower-priority AUTO does not get displaced.
  current = { ...current, priority: TRIGGER_PRIORITY[current.reason] || 0 };
  if (candidate.priority > current.priority) return candidate;
  if (candidate.priority < current.priority) return current;
  const currentSequence = Number(current.sequence || 0);
  const candidateSequence = Number(candidate.sequence || 0);
  return candidateSequence >= currentSequence ? candidate : current;
}

function compactMessage(message) {
  return {
    messageId: message.messageId,
    sequence: Number(message.sequence || 0),
    senderId: message.senderId,
    senderName: message.senderName,
    senderRole: message.senderRole || null,
    trust: message.trust,
    eventType: message.eventType || null,
    pokeTargetId: message.pokeTargetId || null,
    timestamp: message.timestamp,
    displayTime: message.displayTime || null,
    text: String(message.text || "").slice(0, 3000),
    links: (message.links || []).slice(0, 40),
    images: (message.images || []).map((image) => ({ localPath: image.localPath || null, mimeType: image.mimeType, size: image.size, error: image.error || null })),
    attachments: (message.attachments || []).map((attachment) => ({
      type: attachment.type,
      name: attachment.name,
      fileId: attachment.fileId || null,
      localPath: attachment.localPath || null,
      size: Number(attachment.size || 0),
      error: attachment.error || null
    }))
  };
}

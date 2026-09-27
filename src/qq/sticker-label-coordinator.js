export class StickerLabelCoordinator {
  constructor({
    targetType,
    store,
    stickerManager,
    stickerLabeler,
    taskGate = null,
    canRun = () => true,
    getActiveReply = () => null,
    afterCommit = () => {},
    onEvent = () => {}
  } = {}) {
    this.targetType = targetType === "private" ? "private" : "group";
    this.store = store;
    this.stickerManager = stickerManager;
    this.stickerLabeler = stickerLabeler;
    this.taskGate = taskGate;
    this.canRun = canRun;
    this.getActiveReply = getActiveReply;
    this.afterCommit = afterCommit;
    this.onEvent = onEvent;
    this.recognitionQueues = new Map();
    this.commitQueues = new Map();
    this.commitBarriers = new Map();
  }

  schedule(targetId, messages = []) {
    const id = String(targetId);
    if (!this.canRun(id) || !this.stickerLabeler || !this.stickerManager) return Promise.resolve({ scheduled: false });
    const previous = this.recognitionQueues.get(id) || Promise.resolve();
    const task = async () => {
      if (!this.canRun(id)) return { scheduled: false };
      const result = await this.recognize(id, messages);
      return result ? this.enqueueCommit(id, result) : { scheduled: false };
    };
    const recognition = previous.catch(() => {}).then(() => this.taskGate ? this.taskGate.shared(task) : task());
    this.recognitionQueues.set(id, recognition);
    recognition.finally(() => {
      if (this.recognitionQueues.get(id) === recognition) this.recognitionQueues.delete(id);
    }).catch(() => {});
    return recognition;
  }

  recover(targetId) {
    const messages = this.store.snapshot(targetId).pendingMessages || [];
    const staged = this.stickerManager?.stagedLabels?.(messages) || [];
    const commit = () => this.enqueueCommit(String(targetId), { kind: "success", model: "recovered", labels: staged });
    const committing = staged.length
      ? (this.taskGate ? this.taskGate.shared(commit) : commit())
      : Promise.resolve();
    return Promise.all([committing, this.schedule(targetId, messages)]);
  }

  hasCommitBarrier(targetId) {
    return this.commitBarriers.has(String(targetId));
  }

  waitForCommit(targetId) {
    return this.commitBarriers.get(String(targetId)) || null;
  }

  async recognize(targetId, messages) {
    const eventTarget = this.targetType === "private" ? { userId: targetId } : { groupId: targetId };
    this.onEvent({
      type: this.targetType === "private" ? "private-sticker-label-started" : "sticker-label-started",
      ...eventTarget,
      at: new Date().toISOString()
    });
    try {
      const result = await this.stickerLabeler.labelMessages(messages, {
        targetType: this.targetType,
        targetId,
        deferCommit: true
      });
      if (!result.labels?.length) return null;
      return { kind: "success", model: result.model, labels: result.labels };
    } catch (error) {
      const discardedIds = error.discardedStickerIds?.length
        ? error.discardedStickerIds
        : await this.stickerManager.discardCandidates(this.stickerManager.labelRequests(messages, { includeInProgress: true })).catch(() => []);
      return { kind: "failure", error, discardedIds };
    }
  }

  enqueueCommit(targetId, result) {
    const id = String(targetId);
    const queue = this.commitQueues.get(id) || [];
    queue.push(result);
    this.commitQueues.set(id, queue);
    let barrier = this.commitBarriers.get(id);
    if (!barrier) {
      barrier = this.drainCommits(id).finally(() => {
        this.commitBarriers.delete(id);
        if ((this.commitQueues.get(id) || []).length === 0) this.commitQueues.delete(id);
        queueMicrotask(() => Promise.resolve(this.afterCommit(id)).catch(() => {}));
      });
      this.commitBarriers.set(id, barrier);
    }
    return barrier;
  }

  async drainCommits(targetId) {
    const activeReply = this.getActiveReply(targetId);
    if (activeReply) await activeReply.catch(() => {});

    const eventTarget = this.targetType === "private" ? { userId: targetId } : { groupId: targetId };
    const queue = this.commitQueues.get(targetId) || [];
    while (queue.length) {
      const result = queue.shift();
      if (result.kind === "success") {
        const ids = result.labels.map((label) => String(label.id || "")).filter(Boolean);
        const updated = await this.stickerManager.commitStagedLabels(ids);
        await this.store.applyStickerLabelResults(targetId, updated);
        this.onEvent({
          type: this.targetType === "private" ? "private-stickers-labeled" : "stickers-labeled",
          ...eventTarget,
          model: result.model,
          stickerIds: updated.map((entry) => entry.id),
          at: new Date().toISOString()
        });
      } else {
        await this.store.applyStickerLabelResults(targetId, [], { discardedIds: result.discardedIds });
        this.onEvent({
          type: this.targetType === "private" ? "private-sticker-label-error" : "sticker-label-error",
          ...eventTarget,
          discardedStickerIds: result.discardedIds,
          error: result.error?.message || String(result.error || "表情识别失败"),
          at: new Date().toISOString()
        });
      }
    }
  }
}

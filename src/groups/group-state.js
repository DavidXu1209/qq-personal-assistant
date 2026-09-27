export function toPublicGroupState(group, live = null, metadata = {}) {
  const liveState = live || { status: "idle", text: "", error: null };
  const waiting = liveState.status === "waiting";
  const running = liveState.status === "running" || waiting;
  const uploading = liveState.status === "uploading";
  return {
    groupId: group.groupId,
    replyEnabled: group.replyEnabled !== false,
    groupName: metadata.groupName || null,
    threadId: group.threadId,
    codexConfig: group.codexConfig || null,
    threadCreatedAt: group.threadCreatedAt,
    lastActivityAt: group.lastActivityAt,
    lastCompletedReply: group.lastCompletedReply || null,
    pendingMessages: group.pendingMessages,
    pendingCount: group.pendingMessages.length,
    busy: group.busy || waiting,
    pendingTrigger: group.pendingTrigger,
    processingUntilMessageId: group.processing?.processingUntilMessageId || null,
    processing: group.processing,
    failedDelivery: group.failedDelivery
      ? {
          failedAt: group.failedDelivery.failedAt,
          processingUntilMessageId: group.failedDelivery.processingUntilMessageId,
          trigger: group.failedDelivery.trigger,
          subscriptionIds: (group.failedDelivery.subscriptionConsumptions || []).map((item) => item.subscriptionId)
        }
      : null,
    lastError: group.lastError,
    resumeError: group.resumeError,
    activeReply: {
      running,
      waiting,
      waitUntil: waiting ? liveState.waitUntil || null : null,
      uploading,
      status: liveState.status || "idle",
      text: running || uploading ? String(liveState.text || "") : "",
      startedAt: running || uploading ? liveState.startedAt || null : null,
      updatedAt: running || uploading ? liveState.updatedAt || null : null,
      trigger: running || uploading ? liveState.trigger || null : null,
      turnId: running || uploading ? liveState.turnId || null : null,
      error: liveState.error || null
    }
  };
}

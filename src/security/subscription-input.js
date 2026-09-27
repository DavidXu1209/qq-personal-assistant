import { createHash } from "node:crypto";

const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 256;

// Receipts belong to one subscription/target. Only successfully delivered
// notifications may create them; silent decisions and failures never do.
export function recentNotificationReceipts(receipts, now = Date.now()) {
  const byFingerprint = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    const at = Date.parse(receipt?.notifiedAt);
    if (!/^[a-f0-9]{64}$/.test(receipt?.fingerprint || "") || !Number.isFinite(at)) continue;
    if (at > now || now - at >= RECEIPT_TTL_MS) continue;
    const previous = byFingerprint.get(receipt.fingerprint);
    if (!previous || Date.parse(previous.notifiedAt) < at) byFingerprint.set(receipt.fingerprint, receipt);
  }
  return [...byFingerprint.values()].sort((a, b) => Date.parse(a.notifiedAt) - Date.parse(b.notifiedAt)).slice(-MAX_RECEIPTS);
}

export function notificationFingerprint(message, sourceGroupId) {
  if (message.contextOnly || !["admin", "owner"].includes(String(message.senderRole).toLowerCase())) return null;
  const text = String(message.text || "").trim();
  // Short/context-dependent fragments are not safe to suppress locally.
  if (text.length < 12 || /现在|刚刚|刚才|马上|稍后|一会儿|稍等/.test(text)) return null;
  const timestamp = Date.parse(message.timestamp);
  if (!Number.isFinite(timestamp)) return null;
  const media = [...(message.images || []), ...(message.attachments || [])].map((item) => {
    const identity = item.sha256 || item.fileId || item.file;
    // Mutable URLs and failed/unavailable media are not proof of sameness.
    return identity && item.localPath && !item.error ? [identity, item.name || "", item.size || 0] : null;
  });
  if (media.some((item) => item == null)) return null;
  const day = new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return createHash("sha256").update(JSON.stringify([
    String(sourceGroupId), String(message.senderId), message.senderRole, day, text,
    (message.mentions || []).map((mention) => [mention.userId, Boolean(mention.isAll)]),
    message.quotedMessage || message.replyToMessageId || null, media
  ])).digest("hex");
}

export function optimizeSubscriptionInput(contexts, { now = Date.now() } = {}) {
  const seen = new Set();
  const input = [];
  for (const context of contexts || []) {
    const notified = new Set(recentNotificationReceipts(context.notifiedFingerprints, now).map((item) => item.fingerprint));
    const messages = (context.messages || []).filter((message) => {
      const fingerprint = notificationFingerprint(message, context.sourceGroupId);
      if (!fingerprint) return true;
      if (notified.has(fingerprint) || seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
    // Look-behind alone must not create a model call after exact duplicates
    // were removed. The original claim still owns every processing cursor.
    if (messages.some((message) => !message.contextOnly)) input.push({ ...context, messages });
  }
  return input;
}

export function markNotifiedClaims(claims, inputContexts) {
  for (const claim of claims) {
    const input = inputContexts.find((context) => context.subscriptionId === claim.subscriptionId);
    claim.notificationFingerprints = [...new Set((input?.messages || [])
      .map((message) => notificationFingerprint(message, claim.sourceGroupId)).filter(Boolean))];
  }
}

export function uniqueImagePaths(messages) {
  return [...new Set((messages || []).flatMap((message) =>
    (message.images || []).map((image) => image.localPath).filter(Boolean)))];
}

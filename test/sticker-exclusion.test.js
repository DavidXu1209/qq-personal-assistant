import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { QqStickerStore } from "../src/qq/sticker-store.js";
import { EphemeralStickerLabeler } from "../src/qq/sticker-labeler.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "crc-sticker-exclusion-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let favorites = 0;
  const options = {
    filePath: join(root, "stickers.json"), libraryDir: join(root, "library"),
    oneBot: { async fetchCustomFaceDetails() { return []; } },
    fileManager: { async addCustomFace() { favorites++; return { emojiId: "test-favorite" }; } },
    clock: () => new Date("2026-09-27T08:00:00.000Z")
  };
  const manager = new QqStickerStore(options);
  await manager.init();
  const source = join(root, "message.gif");
  await writeFile(source, "original-sticker");
  const message = (image = {}) => ({
    groupId: "group-a", senderId: "member", messageId: "incoming-1",
    images: [{ localPath: source, isSticker: true, mimeType: "image/gif", ...image }]
  });
  async function admit(image = {}) {
    const [candidate] = await manager.collectFromMessage(message(image));
    const [entry] = await manager.applyLabels([{ id: candidate.id, usage: "适合夸张表达震惊和无语时使用" }]);
    return entry;
  }
  return { root, manager, options, source, message, admit, favorites: () => favorites };
}

test("blacklisting retains a recoverable preview and skips repeat labeling across groups and restart", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.publicState().excludedCount, 1);
  assert.ok(await stat(entry.localPath));
  assert.equal(await readFile(f.source, "utf8"), "original-sticker");
  const record = f.manager.state.excluded[entry.id];
  assert.equal(record.reason, "manual");
  assert.equal(record.excludedAt, "2026-09-27T08:00:00.000Z");
  assert.ok(record.sha256s.length && record.md5s.length);
  assert.equal(record.archivedSticker.localPath, entry.localPath);
  assert.equal(record.archivedSticker.usage, entry.usage);
  const visible = f.manager.publicState().excludedItems[0];
  assert.equal(visible.hasPreview, true);
  assert.equal(visible.canRestore, true);
  for (const property of ["localPath", "sha256s", "marketKey", "lastSource"]) assert.equal(visible[property], undefined);

  const restored = new QqStickerStore(f.options);
  await restored.init();
  const replay = { ...f.message(), groupId: "group-b", messageId: "repeat" };
  assert.deepEqual(await restored.collectFromMessage(replay), []);
  assert.equal(replay.images[0].stickerExcluded, true);
  assert.equal(replay.images[0].stickerNeedsReview, false);
  assert.equal(replay.images[0].stickerCandidate, false);
  assert.equal(restored.state.excluded[entry.id].receiveCount, 1);
  assert.equal(restored.publicState().awaitingAi, 0);
  assert.deepEqual(restored.labelRequests([replay], { includeInProgress: true }), []);
  assert.deepEqual(restored.promptCatalog(), []);
  assert.deepEqual(restored.resolveRequests([{ id: entry.id }]), []);
  assert.equal(restored.imageAsset(entry.id).localPath, entry.localPath);
  assert.equal(restored.imageAsset(entry.id).ready, false);
  let calls = 0;
  const labeler = new EphemeralStickerLabeler({
    stickerManager: restored, workspaceRoot: join(f.root, "jobs"),
    codex: { async deleteThread() { calls++; }, async startThread() { calls++; }, async runTurn() { calls++; } }
  });
  assert.deepEqual(await labeler.labelMessages([replay], { targetType: "group", targetId: "group-b" }), { updated: [], discardedIds: [], model: null });
  assert.equal(calls, 0);
  assert.equal(f.favorites(), 1, "excluded repeats must not re-add QQ favorites");
});

test("excluded MD5 remains an independent duplicate key", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  f.manager.state.excluded[entry.id].sha256s = [];
  await f.manager.save();
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const replay = f.message();
  assert.deepEqual(await restored.collectFromMessage(replay), []);
  assert.equal(replay.images[0].stickerExcluded, true);
  assert.equal(restored.state.excluded[entry.id].sha256s.length, 1);
});

test("excluded native QQ ID suppresses changed bytes and remembers aliases for later image-only resends", async (t) => {
  const f = await fixture(t);
  const emojiId = "abcdef0123456789abcdef0123456789";
  const entry = await f.admit({ emojiId });
  await f.manager.deleteSticker(entry.id);
  const secondPath = join(f.root, "second.gif");
  await writeFile(secondPath, "different-encoding");
  const nativeReplay = f.message({ localPath: secondPath, emojiId: emojiId.toUpperCase() });
  assert.deepEqual(await f.manager.collectFromMessage(nativeReplay), []);
  assert.equal(f.manager.state.excluded[entry.id].sha256s.length, 2);
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const plainReplay = f.message({ localPath: secondPath });
  assert.deepEqual(await restored.collectFromMessage(plainReplay), []);
  assert.equal(plainReplay.images[0].stickerId, entry.id);
  assert.equal(plainReplay.images[0].stickerExcluded, true);
  assert.equal(restored.state.excluded[entry.id].receiveCount, 2);
  assert.equal(restored.publicState().ready, 0);
  assert.equal(restored.publicState().needsReview, 0);
  assert.equal(await readFile(secondPath, "utf8"), "different-encoding");
});

test("failed persistence does not delete the original entry or create an exclusion", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  const save = f.manager.save;
  f.manager.save = async () => { throw new Error("disk full"); };
  await assert.rejects(f.manager.deleteSticker(entry.id), /disk full/);
  f.manager.save = save;
  assert.equal(f.manager.publicState().ready, 1);
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.ok(await stat(entry.localPath));
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.equal(restored.publicState().ready, 1);
  assert.equal(restored.publicState().excludedCount, 0);
});

test("forgetting persists before cleanup and retries failed file cleanup after restart", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  f.manager.removeManagedFile = async () => { throw new Error("temporarily busy"); };
  await f.manager.deleteSticker(entry.id);
  await f.manager.forgetSticker(entry.id);
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.equal(f.manager.publicState().cleanupPending, 1);
  assert.ok(await stat(entry.localPath));
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.equal(restored.publicState().excludedCount, 0);
  assert.equal(restored.publicState().cleanupPending, 0);
  await assert.rejects(stat(entry.localPath), { code: "ENOENT" });
  assert.equal((await restored.collectFromMessage(f.message()))[0].labelStatus, "awaiting_ai");
});

test("discarded recognition failures can still be admitted on a later message", async (t) => {
  const f = await fixture(t);
  const [candidate] = await f.manager.collectFromMessage(f.message());
  await f.manager.discardCandidates([{ id: candidate.id }]);
  assert.equal(f.manager.publicState().excludedCount, 0);
  const [newCandidate] = await f.manager.collectFromMessage(f.message());
  assert.equal(newCandidate.labelStatus, "awaiting_ai");
  assert.equal(f.manager.publicState().awaitingAi, 1);
  assert.equal(await f.manager.deleteSticker("st_000000000000"), null);
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.equal(await readFile(f.source, "utf8"), "original-sticker");
});

test("a repeated arrival queued with deletion cannot recreate a candidate", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  const replay = f.message();
  const [, collected] = await Promise.all([f.manager.deleteSticker(entry.id), f.manager.collectFromMessage(replay)]);
  assert.deepEqual(collected, []);
  assert.equal(replay.images[0].stickerExcluded, true);
  assert.equal(f.manager.publicState().excludedCount, 1);
  assert.equal(f.manager.publicState().awaitingAi, 0);
});

test("malformed legacy fingerprints cannot cause deletion without a durable exclusion", async (t) => {
  const f = await fixture(t);
  const entry = await f.admit();
  const stored = f.manager.state.stickers[entry.id];
  stored.sha256 = "invalid";
  stored.md5 = "invalid";
  stored.marketEmojiId = null;
  await assert.rejects(f.manager.deleteSticker(entry.id), /缺少有效指纹/);
  assert.equal(f.manager.publicState().ready, 1);
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.ok(await stat(entry.localPath));
});

test("restore keeps description, native send metadata and all byte aliases across restart", async (t) => {
  const f = await fixture(t);
  const emojiId = "abcdef0123456789abcdef0123456789";
  const entry = await f.admit({ emojiId });
  await f.manager.deleteSticker(entry.id);
  const alias = join(f.root, "alias.gif");
  await writeFile(alias, "alternate-bytes");
  await f.manager.collectFromMessage(f.message({ localPath: alias, emojiId }));
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.deepEqual(await restored.restoreExcluded(entry.id), { id: entry.id, restored: true, awaitingNewArrival: false });
  assert.equal(restored.publicState().excludedCount, 0);
  assert.equal(restored.publicState().ready, 1);
  assert.equal(restored.promptCatalog()[0].usage, entry.usage);
  assert.equal(restored.state.stickers[entry.id].favoriteEmojiId, "test-favorite");
  const reloaded = new QqStickerStore(f.options);
  await reloaded.init();
  const replay = f.message({ localPath: alias });
  assert.equal((await reloaded.collectFromMessage(replay))[0].id, entry.id);
  assert.equal(reloaded.publicState().awaitingAi, 0);
  assert.equal(replay.images[0].stickerExcluded, false);
  await reloaded.deleteSticker(entry.id);
  assert.equal(reloaded.state.excluded[entry.id].sha256s.length, 2);
});

test("forgetting clears SHA, MD5 and native aliases and makes next arrival a fresh candidate", async (t) => {
  const f = await fixture(t);
  const emojiId = "abcdef0123456789abcdef0123456789";
  const entry = await f.admit({ emojiId });
  await f.manager.deleteSticker(entry.id);
  const alias = join(f.root, "alias.gif");
  await writeFile(alias, "alternate-bytes");
  await f.manager.collectFromMessage(f.message({ localPath: alias, emojiId }));
  assert.deepEqual(await f.manager.forgetSticker(entry.id), { id: entry.id, forgotten: true });
  assert.equal(f.manager.publicState().excludedCount, 0);
  assert.equal(f.manager.imageAsset(entry.id), null);
  await assert.rejects(stat(entry.localPath), { code: "ENOENT" });
  assert.equal(await readFile(f.source, "utf8"), "original-sticker");
  assert.equal(await readFile(alias, "utf8"), "alternate-bytes");
  const restored = new QqStickerStore(f.options);
  await restored.init();
  const replay = f.message({ localPath: alias, emojiId });
  const [candidate] = await restored.collectFromMessage(replay);
  assert.equal(candidate.labelStatus, "awaiting_ai");
  assert.equal(candidate.usage, "");
  assert.equal(candidate.receiveCount, 1);
  assert.equal(replay.images[0].stickerExcluded, false);
  assert.equal(restored.labelRequests([replay]).length, 1);
});

test("a ready sticker can be forgotten directly without adding a blacklist record", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.forgetSticker(entry.id);
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.publicState().excludedCount, 0);
  await assert.rejects(stat(entry.localPath), { code: "ENOENT" });
  assert.equal((await f.manager.collectFromMessage(f.message()))[0].labelStatus, "awaiting_ai");
});

test("legacy fingerprint-only exclusions migrate, replenish previews without AI, and can be unblocked", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  delete f.manager.state.excluded[entry.id].archivedSticker;
  await f.manager.removeManagedFile(entry.localPath);
  f.manager.state.version = 3;
  await f.manager.save();
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.equal(restored.state.version, 4);
  assert.equal(restored.publicState().excludedItems[0].hasPreview, false);
  const replay = f.message();
  assert.deepEqual(await restored.collectFromMessage(replay), []);
  assert.equal(replay.images[0].stickerExcluded, true);
  assert.equal(restored.labelRequests([replay]).length, 0);
  assert.equal(restored.publicState().excludedItems[0].hasPreview, true);
  assert.equal(restored.publicState().excludedItems[0].canRestore, false);
  const preview = restored.imageAsset(entry.id).localPath;
  assert.equal(await readFile(preview, "utf8"), "original-sticker");
  assert.deepEqual(await restored.restoreExcluded(entry.id), { id: entry.id, restored: false, awaitingNewArrival: true });
  await assert.rejects(stat(preview), { code: "ENOENT" });
  assert.equal((await restored.collectFromMessage(f.message()))[0].labelStatus, "awaiting_ai");
});

test("missing archive cannot resurrect a broken ready entry", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  await f.manager.removeManagedFile(entry.localPath);
  const result = await f.manager.restoreExcluded(entry.id);
  assert.equal(result.awaitingNewArrival, true);
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.publicState().excludedCount, 0);
});

test("failed restore and forget transactions preserve the archive and fingerprint suppression", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  const save = f.manager.save;
  f.manager.save = async () => { throw new Error("disk full"); };
  await assert.rejects(f.manager.restoreExcluded(entry.id), /disk full/);
  await assert.rejects(f.manager.forgetSticker(entry.id), /disk full/);
  f.manager.save = save;
  assert.equal(f.manager.publicState().ready, 0);
  assert.equal(f.manager.publicState().excludedCount, 1);
  assert.ok(await stat(entry.localPath));
  const restored = new QqStickerStore(f.options);
  await restored.init();
  assert.deepEqual(await restored.collectFromMessage(f.message()), []);
});

test("queue ordering makes a post-forget arrival new without stale labels resurrecting it", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  await f.manager.forgetSticker(entry.id);
  assert.deepEqual(await f.manager.applyLabels([{ id: entry.id, usage: entry.usage }]), []);
  const [next] = await f.manager.collectFromMessage(f.message());
  await f.manager.applyLabels([{ id: next.id, usage: entry.usage }]);
  const replay = f.message();
  const [, collected] = await Promise.all([f.manager.forgetSticker(next.id), f.manager.collectFromMessage(replay)]);
  assert.equal(collected[0].labelStatus, "awaiting_ai");
  assert.equal(replay.images[0].stickerExcluded, false);
});

test("restore and forget reject archive paths outside the managed library", async (t) => {
  const f = await fixture(t), entry = await f.admit();
  await f.manager.deleteSticker(entry.id);
  f.manager.state.excluded[entry.id].archivedSticker.localPath = f.source;
  await assert.rejects(f.manager.restoreExcluded(entry.id), /不属于网关表情库/);
  await assert.rejects(f.manager.forgetSticker(entry.id), /不属于网关表情库/);
  assert.equal(await readFile(f.source, "utf8"), "original-sticker");
  assert.equal(f.manager.publicState().excludedCount, 1);
});

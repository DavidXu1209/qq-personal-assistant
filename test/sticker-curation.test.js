import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { AgentTaskGate } from "../src/qq/agent-task-gate.js";
import { EphemeralStickerCurator, StickerCurationCoordinator, nextStickerCheck, parseStickerSelection } from "../src/qq/sticker-curator.js";
import { QqStickerStore } from "../src/qq/sticker-store.js";
import { StickerLabelCoordinator } from "../src/qq/sticker-label-coordinator.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { SessionStore } from "../src/storage/session-store.js";

function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
async function until(check) { for (let n = 0; n < 100; n++) { if (check()) return; await pause(5); } throw new Error("Test condition never became true"); }
async function fixture(t, count = 101) {
  const root = await mkdtemp(join(tmpdir(), "crc-curation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  const manager = new QqStickerStore({ filePath: join(root, "stickers.json"), libraryDir });
  await manager.init();
  for (let n = 1; n <= count; n++) {
    const id = `st_${n.toString(16).padStart(12, "0")}`;
    const localPath = join(libraryDir, `${id}.gif`);
    await writeFile(localPath, `original-${n}`);
    manager.state.stickers[id] = { id, localPath, sha256: createHash("sha256").update(`original-${n}`).digest("hex"), usage: "适合夸张表达震惊时使用", labelStatus: "ready", receiveCount: 1, sendCount: 0 };
  }
  await manager.save();
  return { root, manager };
}

test("daily sticker check uses Shanghai 05:00 and does not immediately curate on installation after 05:00", () => {
  assert.equal(nextStickerCheck(new Date("2026-09-27T04:59:59+08:00")), "2026-09-26T21:00:00.000Z");
  assert.equal(nextStickerCheck(new Date("2026-09-27T05:00:00+08:00")), "2026-09-27T21:00:00.000Z");
  assert.equal(nextStickerCheck(new Date("2026-09-27T15:00:00+08:00")), "2026-09-27T21:00:00.000Z");
});

test("maintenance drains existing tasks, blocks newcomers, and releases even after failure", async () => {
  const gate = new AgentTaskGate();
  const old = gate.tryEnter();
  const events = [];
  const maintenance = gate.exclusive(async () => { events.push("prune"); throw new Error("test failure"); });
  const caught = assert.rejects(maintenance, /test failure/);
  const reply = gate.shared(async () => { events.push("reply"); });
  const label = gate.shared(async () => { events.push("label"); });
  assert.equal(gate.blocked, true);
  assert.equal(gate.tryEnter(), null);
  await pause(1);
  assert.deepEqual(events, []);
  old(); old();
  await Promise.all([caught, reply, label]);
  assert.equal(events[0], "prune");
  assert.deepEqual(gate.snapshot(), { blocked: false, running: false, activeTasks: 0, queuedTasks: 0 });
});

test("multiple maintenance requests serialize without admitting a reply between them", async () => {
  const gate = new AgentTaskGate();
  const events = [];
  const first = gate.exclusive(async () => events.push("first"));
  const second = gate.exclusive(async () => events.push("second"));
  const reply = gate.shared(async () => events.push("reply"));
  await Promise.all([first, second, reply]);
  assert.deepEqual(events, ["first", "second", "reply"]);
});

test("selection rejects wrong counts, repeated and invented ids", () => {
  const entries = Array.from({ length: 101 }, (_, n) => ({ id: `id-${n}` }));
  const ids = entries.slice(0, 80).map((e) => e.id);
  assert.deepEqual(parseStickerSelection(JSON.stringify({ keepIds: ids }), entries), ids);
  assert.deepEqual(parseStickerSelection(`我选择如下：\n\`\`\`json\n${JSON.stringify({ keepIds: ids })}\n\`\`\``, entries), ids);
  for (const keepIds of [ids.slice(1), [...ids.slice(1), ids[1]], [...ids.slice(1), "fake"]]) {
    assert.throws(() => parseStickerSelection(JSON.stringify({ keepIds }), entries), /真实表情 ID/);
  }
});

test("retaining 80 atomically archives exclusions into the blacklist and survives restart", async (t) => {
  const { root, manager } = await fixture(t);
  const original = join(root, "qq-message-image.gif");
  await writeFile(original, "message-original");
  const catalog = manager.curationCatalog();
  const keep = catalog.slice(0, 80).map((e) => e.id);
  assert.equal((await manager.retainSelection(catalog, keep)).length, 21);
  assert.equal(manager.publicState().total, 80);
  assert.equal(manager.publicState().excludedCount, 21);
  assert.equal(manager.state.excluded[catalog[100].id].reason, "curation");
  assert.ok(await stat(catalog[100].localPath));
  assert.equal(manager.publicState().excludedItems.length, 21);
  assert.equal(manager.publicState().excludedItems.every((item) => item.hasPreview && item.canRestore), true);
  assert.equal(await readFile(original, "utf8"), "message-original");
  const restored = new QqStickerStore({ filePath: manager.filePath, libraryDir: manager.libraryDir });
  await restored.init();
  assert.equal(restored.publicState().total, 80);
  assert.equal(restored.publicState().cleanupPending, 0);
  assert.equal(restored.publicState().excludedCount, 21);
  const replay = { images: [{ localPath: original, isSticker: true }] };
  await writeFile(original, "original-101");
  assert.deepEqual(await restored.collectFromMessage(replay), []);
  assert.equal(replay.images[0].stickerExcluded, true);
  assert.deepEqual(restored.labelRequests([replay]), []);
  assert.equal(restored.publicState().awaitingAi, 0);
});

test("manual changes and failed persistence cannot delete stale library snapshots", async (t) => {
  const { manager } = await fixture(t);
  const entries = manager.curationCatalog();
  const keep = entries.slice(0, 80).map((e) => e.id);
  manager.state.stickers[entries[0].id].usage = "适合表达委屈时使用";
  await assert.rejects(manager.retainSelection(entries, keep), /已被编辑/);
  manager.state.stickers[entries[0].id].usage = entries[0].usage;
  const save = manager.save;
  manager.save = async () => { throw new Error("disk failure"); };
  await assert.rejects(manager.retainSelection(entries, keep), /disk failure/);
  manager.save = save;
  assert.equal(manager.publicState().total, 101);
  assert.equal(manager.publicState().excludedCount, 0);
  assert.ok(await stat(entries[100].localPath));
});

test("temporary selector visually reviews every batch, uses the label model, and immediately deletes each bounded session", async (t) => {
  const { root, manager } = await fixture(t);
  const entries = manager.curationCatalog();
  const requests = [];
  let deleted;
  let starts = 0;
  let deletes = 0;
  const codex = {
    async startThread(options) { assert.equal(starts, deletes, "the previous image context must be gone before opening another batch"); starts++; assert.equal(options.model, "chosen-vision-model"); assert.equal(options.ephemeral, true); assert.equal(options.workingMode, "agent"); return options.threadId; },
    async runTurn(options) {
      requests.push(options);
      assert.match(options.threadId, /^sticker-prune-/);
      assert.equal(options.turnSandbox.type, "readOnly");
      if (options.imagePaths) {
        const line = options.prompt.split("\n").find((line) => line.startsWith("本批 "));
        const batch = JSON.parse(line.slice(line.indexOf("[")));
        return { text: JSON.stringify({ ratings: batch.map(({ id }) => ({ id, drama: 8, usefulness: 8, category: "震惊" })) }) };
      }
      return { text: JSON.stringify({ keepIds: entries.slice(0, 80).map((e) => e.id) }) };
    },
    async deleteThread(_id, options) { deletes++; deleted = options; }
  };
  const selector = new EphemeralStickerCurator({ codex, workspaceRoot: join(root, "jobs"), getSettings: () => ({ model: "chosen-vision-model" }) });
  const selected = await selector.select(entries);
  assert.equal(selected.keepIds.length, 80);
  assert.equal(requests.length, 6);
  assert.equal(deletes, 6);
  assert.equal(requests.flatMap((r) => r.imagePaths || []).length, 101);
  assert.equal(deleted.purgeProject, true);
  await assert.rejects(stat(deleted.cwd), { code: "ENOENT" });
  assert.equal(manager.publicState().total, 101, "selection itself must not mutate the real library");
});

test("invalid vision results clean the disposable session and leave every sticker intact", async (t) => {
  const { root, manager } = await fixture(t);
  let deleted = false;
  const selector = new EphemeralStickerCurator({ workspaceRoot: join(root, "jobs"), codex: {
    startThread: async (o) => o.threadId, runTurn: async () => ({ text: "not json" }), deleteThread: async () => { deleted = true; }
  } });
  await assert.rejects(selector.select(manager.curationCatalog()), /有效 JSON/);
  assert.equal(deleted, true);
  assert.equal(manager.publicState().total, 101);
});

test("05:00 queues all group/private replies, labels and Space work behind curation while retaining incoming messages", async (t) => {
  const { root, manager } = await fixture(t);
  const gate = new AgentTaskGate();
  const oldReply = deferred();
  const pruning = deferred();
  const events = [];
  const dummyStore = { snapshot: () => ({ replyEnabled: true }), rateLimitUntil: () => 0 };
  const group = new GroupWorker({ store: dummyStore, taskGate: gate });
  const privateWorker = new PrivateWorker({ store: dummyStore, taskGate: gate });
  group.runLoop = async () => { events.push("old-reply"); await oldReply.promise; };
  privateWorker.runLoop = async () => { events.push("private-reply"); };
  const first = group.kick("group");
  let now = new Date("2026-09-27T04:59:59+08:00");
  const coordinator = new StickerCurationCoordinator({ filePath: join(root, "curation.json"), stickerManager: manager, gate, clock: () => now, selector: {
    async select(entries) { events.push("prune"); await pruning.promise; return { model: "vision", keepIds: entries.slice(0, 80).map((e) => e.id) }; }
  } });
  await coordinator.init();
  now = new Date("2026-09-27T05:00:00+08:00");
  const check = coordinator.tick();
  assert.equal(coordinator.tick(), check, "only one daily job can be claimed");
  await until(() => gate.blocked);
  const reply = privateWorker.kick("private");
  const labels = new StickerLabelCoordinator({ taskGate: gate, store: dummyStore, stickerManager: { commitStagedLabels: async () => [] }, stickerLabeler: {
    async labelMessages() { events.push("label"); return { labels: [{ id: "candidate", usage: "test" }] }; }
  } });
  dummyStore.applyStickerLabelResults = async () => {};
  const labeling = labels.schedule("other-group", []);
  const space = privateWorker.runQzoneSequence("private", async () => { events.push("space"); });
  const incoming = new SessionStore({ filePath: join(root, "messages.json") });
  await incoming.init({ allowedGroups: ["group"] });
  await incoming.appendMessage({ groupId: "group", messageId: "new", text: "arrived during maintenance", senderId: "123456789", images: [] });
  assert.deepEqual(events, ["old-reply"]);
  oldReply.resolve();
  await first;
  await until(() => coordinator.snapshot().status === "running" && events.includes("prune"));
  assert.deepEqual(events, ["old-reply", "prune"]);
  assert.equal(incoming.snapshot("group").pendingMessages.length, 1);
  pruning.resolve();
  await Promise.all([check, reply, labeling, space]);
  assert.equal(coordinator.snapshot().status, "completed");
  assert.equal(manager.publicState().total, 80);
  assert.ok(events.includes("private-reply") && events.includes("label") && events.includes("space"));
  assert.ok(events.indexOf("private-reply") < events.indexOf("space"), "an earlier chat wake must run before Space work");
  assert.equal(gate.blocked, false);
  assert.equal(incoming.snapshot("group").pendingMessages.length, 1);
});

test("a paused master switch retains the daily job; exactly 100 stickers never invokes AI", async (t) => {
  const { root, manager } = await fixture(t, 100);
  let now = new Date("2026-09-27T04:59:59+08:00");
  let enabled = false;
  let selected = 0;
  const coordinator = new StickerCurationCoordinator({ filePath: join(root, "curation.json"), stickerManager: manager, gate: new AgentTaskGate(),
    clock: () => now, canRun: () => enabled, selector: { select: async () => { selected++; } } });
  await coordinator.init();
  assert.equal(coordinator.tick(), undefined);
  now = new Date("2026-09-27T05:00:00+08:00");
  await coordinator.tick();
  assert.equal(coordinator.snapshot().status, "queued");
  enabled = true;
  await coordinator.tick();
  assert.equal(coordinator.snapshot().status, "skipped");
  assert.equal(selected, 0);
});

test("failed nightly selection releases the gate without pruning and interrupted jobs recover as queued", async (t) => {
  const { root, manager } = await fixture(t);
  let now = new Date("2026-09-27T04:59:59+08:00");
  const options = { filePath: join(root, "curation.json"), stickerManager: manager, gate: new AgentTaskGate(), clock: () => now,
    selector: { select: async () => { throw new Error("upstream unavailable"); } } };
  const coordinator = new StickerCurationCoordinator(options);
  await coordinator.init();
  now = new Date("2026-09-27T05:00:00+08:00");
  await coordinator.tick();
  assert.equal(coordinator.snapshot().status, "failed");
  assert.equal(options.gate.blocked, false);
  assert.equal(manager.publicState().total, 101);
  coordinator.state.status = "running";
  await coordinator.save();
  const recovered = new StickerCurationCoordinator(options);
  await recovered.init();
  assert.equal(recovered.snapshot().status, "queued");
  assert.equal(recovered.snapshot().nextCheckAt, "2026-09-27T21:00:00.000Z");
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { CodexClient } from "../src/codex/client.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { GroupWorker } from "../src/groups/group-worker.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { SessionStore } from "../src/storage/session-store.js";
import { SubscriptionStore } from "../src/storage/subscription-store.js";
import { notificationFingerprint, optimizeSubscriptionInput, recentNotificationReceipts, uniqueImagePaths } from "../src/security/subscription-input.js";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { toPublicGroupState } from "../src/groups/group-state.js";

const NOTICE = "请于9月20日提交课程作业至班级文件夹。";
const START = Date.parse("2026-09-18T01:00:00Z");
const execFileAsync = promisify(execFile);
test("reply switches persist independently, default on and retain pending controls", async (t) => {
  const f = await createFixture(t, "group");
  await f.sessions.addConversation("other");
  await f.sessions.setReplyEnabled(f.targetId, false);
  const msg = await f.sessions.appendMessage(message("control", "/会话", { groupId: f.targetId }));
  await f.sessions.requestTrigger(f.targetId, "control", msg);
  assert.equal(await f.sessions.beginWork(f.targetId), null);
  assert.equal(toPublicGroupState(f.sessions.snapshot(f.targetId)).replyEnabled, false);
  assert.equal(f.sessions.snapshot("other").replyEnabled, true);
  const restored = new SessionStore({ filePath: f.sessions.filePath });
  await restored.init({ allowedGroups: [f.targetId, "other"] });
  assert.equal(restored.snapshot(f.targetId).replyEnabled, false);
  assert.equal(restored.snapshot(f.targetId).pendingMessages.length, 1);
  assert.equal(restored.snapshot(f.targetId).pendingTrigger.reason, "control");
  await restored.setReplyEnabled(f.targetId, true);
  assert.equal((await restored.beginWork(f.targetId)).kind, "control");
});

test("off/on invalidates an already running batch without losing its trigger", async (t) => {
  const f = await createFixture(t, "group");
  await f.sessions.appendMessage(message("1", "你好", { groupId: f.targetId }));
  await f.sessions.requestTrigger(f.targetId, "mention", {});
  await f.sessions.beginWork(f.targetId);
  await f.sessions.setReplyEnabled(f.targetId, false);
  await f.sessions.setReplyEnabled(f.targetId, true);
  let error;
  try { f.sessions.assertReplyEnabled(f.targetId); } catch (caught) { error = caught; }
  assert.equal(error.code, "REPLY_DISABLED");
  await f.sessions.failWork(f.targetId, error);
  assert.equal(f.sessions.snapshot(f.targetId).pendingTrigger.reason, "mention");
  assert.equal(f.sessions.snapshot(f.targetId).lastError, null);
  assert.equal(f.sessions.snapshot(f.targetId).pendingMessages.length, 1);
  await f.sessions.beginWork(f.targetId);
  assert.doesNotThrow(() => f.sessions.assertReplyEnabled(f.targetId));
});

test("QQ sender blocks disabled group text, files and private text before any request", async () => {
  let requests = 0;
  const client = new OneBotClient({ canReply: (_type, id) => id !== "123", fetchImpl: async () => { requests++; return { ok: true, status: 200, json: async () => ({ status: "ok" }) }; } });
  await assert.rejects(client.sendGroupMessage("123", "no"), { code: "REPLY_DISABLED" });
  await assert.rejects(client.uploadGroupFile("123", "/tmp/file", "file"), { code: "REPLY_DISABLED" });
  await assert.rejects(client.sendPrivateMessage("123", "no"), { code: "REPLY_DISABLED" });
  assert.equal(requests, 0);
  await client.sendGroupMessage("456", "yes");
  await client.sendPrivateMessage("456", "yes");
  assert.equal(requests, 2);
});

test("QQ sender emits SnowLuma image, native sticker, market-face, built-in face and group poke actions", async () => {
  const requests = [];
  const client = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => ({ status: "ok", data: { message_id: 1 } }) };
    }
  });

  await client.sendGroupImage("123", "/tmp/payload.gif");
  await client.sendGroupSticker("123", "/tmp/sticker.gif", { summary: "开心" });
  await client.sendGroupMarketFace("123", { emojiId: "235a82d9c0acd2e2db6e0b94e1a1c4f3", emojiPackageId: 12, key: "abc", summary: "可爱" });
  await client.sendGroupFace("123", 76);
  await client.sendGroupPoke("12345", "456789");
  await client.sendPrivateImage("456", "/tmp/payload.png");
  await client.sendPrivateSticker("456", "/tmp/sticker.png");
  await client.sendPrivateMarketFace("456", { emojiId: "235a82d9c0acd2e2db6e0b94e1a1c4f3" });
  await client.sendPrivateFace("456", 14);

  assert.match(requests[4].url, /\/group_poke$/);

  assert.deepEqual(requests.map((request) => request.body), [
    { group_id: 123, message: [{ type: "image", data: { file: "/tmp/payload.gif" } }] },
    { group_id: 123, message: [{ type: "image", data: { file: "/tmp/sticker.gif", sub_type: 1, summary: "开心" } }] },
    { group_id: 123, message: [{ type: "mface", data: { emoji_id: "235a82d9c0acd2e2db6e0b94e1a1c4f3", emoji_package_id: 12, key: "abc", summary: "可爱" } }] },
    { group_id: 123, message: [{ type: "face", data: { id: 76 } }] },
    { group_id: 12345, user_id: 456789 },
    { user_id: 456, message: [{ type: "image", data: { file: "/tmp/payload.png" } }] },
    { user_id: 456, message: [{ type: "image", data: { file: "/tmp/sticker.png", sub_type: 1, summary: "[动画表情]" } }] },
    { user_id: 456, message: [{ type: "mface", data: { emoji_id: "235a82d9c0acd2e2db6e0b94e1a1c4f3", emoji_package_id: 0, key: "", summary: "表情" } }] },
    { user_id: 456, message: [{ type: "face", data: { id: 14 } }] }
  ]);
});

test("QQ group files use the long-running HTTP transport without affecting normal messages", async () => {
  let fetchCalls = 0;
  let longRequest = null;
  const client = new OneBotClient({
    baseUrl: "http://127.0.0.1:3000",
    accessToken: "test-token",
    fileUploadTimeoutMs: 123456,
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    },
    longRequestImpl: async (url, options) => {
      longRequest = { url, options };
      return { ok: true, status: 200, body: { status: "ok", data: { file_id: "file-1" } } };
    }
  });

  const uploaded = await client.uploadGroupFile("123", "/tmp/payload", "样片.jpg");
  assert.equal(uploaded.fileId, "file-1");
  assert.equal(fetchCalls, 0);
  assert.equal(longRequest.url, "http://127.0.0.1:3000/upload_group_file");
  assert.equal(longRequest.options.timeoutMs, 123456);
  assert.equal(longRequest.options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(longRequest.options.body), {
    group_id: 123,
    file: "/tmp/payload",
    name: "样片.jpg",
    upload_file: true
  });

  await client.sendGroupMessage("123", "普通消息");
  assert.equal(fetchCalls, 1);
});

test("the production long-running transport waits for SnowLuma's delayed JSON response", async (t) => {
  let received = null;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
      };
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: "ok", data: { file_id: "delayed-file" } }));
      }, 25);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const client = new OneBotClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    accessToken: "local-test-token",
    fileUploadTimeoutMs: 1000,
    fetchImpl: async () => { throw new Error("normal fetch must not handle file upload"); }
  });

  const uploaded = await client.uploadGroupFile("200000001", "/tmp/payload", "样片.jpg");
  assert.equal(uploaded.fileId, "delayed-file");
  assert.equal(received.authorization, "Bearer local-test-token");
  assert.equal(received.body.group_id, 200000001);
  assert.equal(received.body.file, "/tmp/payload");
});

for (const type of ["group", "private"]) {
  test(`${type}: disabled reply keeps subscriptions collecting and obeys the global switch on resume`, async (t) => {
    const f = await createFixture(t, type);
    let globalEnabled = false;
    const runnable = f.worker.canRun;
    f.worker.canRun = (id) => globalEnabled && runnable(id);
    await f.sessions.setReplyEnabled(f.targetId, false);
    await f.submit(message("1"));
    await f.submit(message("2", NOTICE + "新增地点。"));
    assert.equal(f.calls, 0);
    assert.equal(f.subscriptions.listSubscriptions()[0].state.pendingCount, 2);
    await f.sessions.setReplyEnabled(f.targetId, true);
    await f.worker.kick(f.targetId);
    assert.equal(f.calls, 0);
    globalEnabled = true;
    await f.worker.kick(f.targetId);
    assert.equal(f.calls, 1);
    assert.equal(f.sends, 1);
    assert.equal(f.subscriptions.listSubscriptions()[0].state.pendingCount, 0);
  });

  test(`${type}: disabling while generating releases AUTO claims without sending or executing actions`, async (t) => {
    const f = await createFixture(t, type);
    let actions = 0;
    f.worker.automationClient = { execute: async () => { actions++; } };
    f.worker.codex.runTurn = async () => {
      f.calls++;
      await f.sessions.setReplyEnabled(f.targetId, false);
      return { text: JSON.stringify({ ...f.reply, actions: [{ type: "reminder", sourceGroupId: "54321", title: "课程作业" }] }), turnId: "turn" };
    };
    await f.submit(message("1"));
    assert.equal(f.sends, 0);
    assert.equal(actions, 0);
    assert.equal(f.sessions.snapshot(f.targetId).lastError, null);
    assert.equal(f.sessions.snapshot(f.targetId).pendingTrigger.reason, "subscription_auto");
    const subscription = f.subscriptions.listSubscriptions()[0];
    assert.equal(subscription.state.pendingCount, 1);
    assert.equal(subscription.state.lastError, null);
    assert.equal(Object.values(f.subscriptions.snapshot().subscriptions)[0].state.collections[0].status, "collecting");
  });

  test(`${type}: disabled delivery retries retain the cached reply and resume without another model call`, async (t) => {
    const f = await createFixture(t, type);
    f.failSend = true;
    await f.submit(message("1"));
    assert.equal(f.calls, 1);
    assert.ok(f.sessions.snapshot(f.targetId).failedDelivery);
    await f.sessions.setReplyEnabled(f.targetId, false);
    await f.sessions.requestTrigger(f.targetId, "retry", {});
    await f.worker.kick(f.targetId);
    assert.equal(f.sends, 1);
    assert.ok(f.sessions.snapshot(f.targetId).failedDelivery);
    f.failSend = false;
    await f.sessions.setReplyEnabled(f.targetId, true);
    await f.worker.kick(f.targetId);
    assert.equal(f.calls, 1);
    assert.equal(f.sends, 2);
    assert.equal(f.sessions.snapshot(f.targetId).failedDelivery, null);
  });
}

test("Codex retry notifications keep the original turn active until completion", () => {
  const client = new CodexClient();
  let resolved;
  let rejected;
  const active = { threadId: "thread", turnId: "turn", groupId: "group", text: "", resolve: (value) => { resolved = value; }, reject: (error) => { rejected = error; } };
  client.activeByThread.set("thread", active);
  client.activeByTurn.set("turn", active);
  client.activeByGroup.set("group", active);
  client.handleMessage({ method: "error", params: { threadId: "thread", turnId: "turn", willRetry: true, error: { message: "temporary disconnection" } } });
  assert.equal(client.activeByTurn.size, 1);
  assert.equal(rejected, undefined);
  client.handleMessage({ method: "item/agentMessage/delta", params: { threadId: "thread", turnId: "turn", delta: "回复" } });
  client.handleMessage({ method: "item/completed", params: { threadId: "thread", turnId: "turn", item: { type: "contextCompaction" } } });
  client.handleMessage({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  assert.equal(resolved.text, "回复");
  assert.equal(resolved.compacted, true);
  assert.equal(client.activeByGroup.size, 0);
});

test("WorkBuddy compaction notification marks the active turn for instruction refresh", () => {
  const client = new WorkBuddyClient();
  let resolved;
  const active = {
    threadId: "thread", turnId: "turn", groupId: "group", text: "回复", compacted: false,
    resolve: (value) => { resolved = value; }, reject: () => {}, timeout: null
  };
  client.activeByThread.set("thread", active);
  client.activeByTurn.set("turn", active);
  client.activeByGroup.set("group", active);
  client.handleMessage({ method: "thread/compacted", params: { threadId: "thread", trigger: "auto" } });
  client.handleMessage({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  assert.equal(resolved.compacted, true);
  assert.equal(client.activeByGroup.size, 0);
});

test("Codex terminal errors retain their detail and ignore another turn's errors", () => {
  const client = new CodexClient();
  let rejected;
  const active = { threadId: "thread", turnId: "turn", groupId: "group", reject: (error) => { rejected = error; } };
  client.activeByThread.set("thread", active);
  client.activeByTurn.set("turn", active);
  client.activeByGroup.set("group", active);
  client.handleMessage({ method: "error", params: { threadId: "thread", turnId: "old-turn", willRetry: false, error: { message: "stale failure" } } });
  assert.equal(client.activeByTurn.size, 1);
  client.handleMessage({ method: "error", params: { threadId: "thread", turnId: "turn", willRetry: false, error: { message: "actual upstream failure" } } });
  assert.equal(rejected.message, "actual upstream failure");
  assert.equal(client.activeByTurn.size, 0);
});

function message(id, text = NOTICE, extra = {}) {
  return { messageId: String(id), groupId: "54321", senderId: "88888", senderName: "管理员", senderRole: "admin", timestamp: new Date(START).toISOString(), displayTime: "2026-09-18 09:00:00", text, trust: "UNTRUSTED", images: [], attachments: [], ...extra };
}

test("short context budgets use growth scope while larger budgets keep total scope", async () => {
  const calls = [];
  const client = new CodexClient({ model: "unchanged-model" });
  client.ensureProcess = async () => {};
  client.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: "same-thread" } }; };
  for (const limit of [32_000, 64_000, 100_000]) {
    const options = { contextTokenLimit: limit };
    assert.equal(await client.startThread(options), "same-thread");
    assert.equal(await client.resumeThread("same-thread", options), "same-thread");
    for (const call of calls.slice(-2)) {
      assert.equal(call.params.model, "unchanged-model");
      assert.equal(call.params.config.model_auto_compact_token_limit, limit);
      assert.equal(call.params.config.model_auto_compact_token_limit_scope, limit <= 64_000 ? "body_after_prefix" : "total");
    }
  }
});

test("exact notice filtering preserves look-behind, changes, short fragments and uncertain media", () => {
  const original = message("1");
  const fingerprint = notificationFingerprint(original, "54321");
  const context = { subscriptionId: "s1", sourceGroupId: "54321", notifiedFingerprints: [{ fingerprint, notifiedAt: new Date(START).toISOString() }], messages: [
    message("ctx", "前面的十条上下文之一", { contextOnly: true, senderRole: "member" }),
    original, message("2", NOTICE + "地点已修改。"), message("3", "收到"),
    message("4", NOTICE, { attachments: [{ name: "安排.pdf", url: "https://example.test/mutable.pdf" }] })
  ] };
  const [input] = optimizeSubscriptionInput([context], { now: START + 60_000 });
  assert.deepEqual(input.messages.map((item) => item.messageId), ["ctx", "2", "3", "4"]);
  assert.equal(context.messages.length, 5, "raw claims are never modified by input filtering");
  assert.equal(notificationFingerprint(message("5", NOTICE, { senderId: "99999" }), "54321") === fingerprint, false);
  assert.equal(notificationFingerprint(message("6", NOTICE, { timestamp: "2026-09-19T01:00:00Z" }), "54321") === fingerprint, false);
  assert.equal(optimizeSubscriptionInput([{ ...context, messages: [context.messages[0], original] }], { now: START + 60_000 }).length, 0);
  assert.equal(optimizeSubscriptionInput([{ ...context, messages: [original] }], { now: START + 25 * 3600_000 }).length, 1);
  assert.deepEqual(uniqueImagePaths([{ images: [
    { localPath: "/tmp/a" },
    { localPath: "/tmp/a" },
    { localPath: "/tmp/b" },
    { localPath: "/tmp/sticker.gif", isSticker: true },
    { localPath: "/tmp/collected.gif", stickerId: "st_abcdef123456" }
  ] }]), ["/tmp/a", "/tmp/b", "/tmp/sticker.gif", "/tmp/collected.gif"]);
  const receipts = Array.from({ length: 300 }, (_, i) => ({ fingerprint: i.toString(16).padStart(64, "0"), notifiedAt: new Date(START + i).toISOString() }));
  assert.equal(recentNotificationReceipts(receipts, START + 1000).length, 256);
});

test("WorkBuddy bridge compresses accumulated images below its shared request budget", {
  skip: process.platform !== "darwin" && "macOS image compression integration requires /usr/bin/sips"
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "crc-workbuddy-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = join(directory, "first.bmp");
  const second = join(directory, "second.bmp");
  const bitmap = solidBmp(1200, 1200);
  await Promise.all([writeFile(first, bitmap), writeFile(second, bitmap)]);

  const bridgePath = join(process.cwd(), "modules/workbuddy-agent/bridge.py");
  const script = [
    "import base64, importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('crc_bridge', sys.argv[1])",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "payload = module.Bridge._build_prompt('hello', sys.argv[2:])",
    "blocks = payload['message']['content']",
    "images = [block for block in blocks if block.get('type') == 'image']",
    "raw = sum(len(base64.b64decode(block['source']['data'])) for block in images)",
    "print(json.dumps({'count': len(images), 'raw': raw, 'text': blocks[0]['text']}))"
  ].join("; ");
  const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", script, bridgePath, first, second], {
    maxBuffer: 2 * 1024 * 1024
  });
  const result = JSON.parse(stdout);
  assert.equal(result.count, 2);
  assert.ok(result.raw <= 4 * 1024 * 1024);
  assert.match(result.text, /临时压缩预览/);
});

test("AUTO merges only expired windows and restores every merged claim on failure", async (t) => {
  const fixture = await createFixture(t, "group");
  await fixture.subscriptions.appendSourceMessage(message("1", NOTICE));
  fixture.advance(61_000);
  await fixture.subscriptions.appendSourceMessage(message("2", NOTICE + "附带第二项。"));
  fixture.advance(61_000);
  await fixture.subscriptions.appendSourceMessage(message("3", NOTICE + "仍然等待。"));
  const claims = await fixture.subscriptions.claimForTarget("group", fixture.targetId, { mode: "AUTO" });
  assert.equal(claims[0].collectionIds.length, 2);
  assert.deepEqual(claims[0].messages.map((item) => item.messageId), ["1", "2"]);
  await fixture.subscriptions.failClaims(claims, new Error("network failure"));
  const state = Object.values(fixture.subscriptions.snapshot().subscriptions)[0].state;
  assert.deepEqual(state.collections.map((item) => item.status), ["collecting", "collecting", "collecting"]);
  assert.equal(state.pendingSequences.length, 3);
  await fixture.subscriptions.retryFailedForTarget("group", fixture.targetId);
  const retried = await fixture.subscriptions.claimForTarget("group", fixture.targetId, { mode: "AUTO" });
  await fixture.subscriptions.completeClaims(retried);
  assert.deepEqual(fixture.subscriptions.listSubscriptions()[0].state.pendingMessages.map((item) => item.messageId), ["3"]);
});

for (const targetType of ["group", "private"]) {
  test(`${targetType}: dedupe is committed only after QQ delivery, survives restart and does not rerun Codex on retry`, async (t) => {
    const fixture = await createFixture(t, targetType);
    fixture.failSend = true;
    await fixture.submit(message("1"));
    assert.equal(fixture.calls, 1);
    assert.equal(Object.values(fixture.subscriptions.snapshot().subscriptions)[0].state.notifiedFingerprints.length, 0);
    assert.ok(fixture.sessions.snapshot(fixture.targetId).failedDelivery);
    fixture.failSend = false;
    await fixture.sessions.requestTrigger(fixture.targetId, "retry", {});
    await fixture.worker.kick(fixture.targetId);
    assert.equal(fixture.calls, 1);
    assert.equal(Object.values(fixture.subscriptions.snapshot().subscriptions)[0].state.notifiedFingerprints.length, 1);
    const restored = new SubscriptionStore({ filePath: fixture.subscriptions.filePath, clock: fixture.subscriptions.clock });
    await restored.init();
    fixture.subscriptions = restored;
    fixture.worker.subscriptionStore = restored;
    await fixture.submit(message("2"));
    assert.equal(fixture.calls, 2, "a new AUTO batch must be summarized even when its content repeats");
    assert.equal(fixture.sessions.snapshot(fixture.targetId).threadId, "persistent-thread");
    assert.equal(fixture.subscriptions.listSubscriptions()[0].state.pendingCount, 0);
    await fixture.submit(message("3", NOTICE + "补充地点：教四。"));
    assert.equal(fixture.calls, 3, "changed content must reach the model");
  });

  test(`${targetType}: a model's notify=false cannot swallow an AUTO notice`, async (t) => {
    const fixture = await createFixture(t, targetType);
    fixture.reply = { notify: false, urgency: "normal", reply: "", ambiguity: "", actions: [] };
    const text = "课程参考资料已更新到班级文件夹供大家阅读。";
    await fixture.submit(message("1", text));
    assert.equal(fixture.sends, 1);
    assert.equal(Object.values(fixture.subscriptions.snapshot().subscriptions)[0].state.notifiedFingerprints.length, 1);
    await fixture.submit(message("2", text));
    assert.equal(fixture.calls, 2, "every triggered AUTO batch receives a summary even when notify=false or duplicated");
    assert.equal(fixture.sends, 2);
  });
}

test("notification receipts are independent for every subscribed target", async (t) => {
  const fixture = await createFixture(t, "group");
  await fixture.submit(message("1"));
  await fixture.subscriptions.upsertSubscription({ targetType: "private", targetId: "100000001", sourceGroupId: "54321", mode: "AUTO", collectionDelayMinutes: 1 });
  await fixture.subscriptions.appendSourceMessage(message("2"));
  fixture.advance(61_000);
  const groupClaims = await fixture.subscriptions.claimForTarget("group", fixture.targetId, { mode: "AUTO" });
  const privateClaims = await fixture.subscriptions.claimForTarget("private", "100000001", { mode: "AUTO" });
  assert.equal(optimizeSubscriptionInput(groupClaims, { now: fixture.now }).length, 0);
  assert.equal(optimizeSubscriptionInput(privateClaims, { now: fixture.now }).length, 1);
});

test("merged delivery claims survive the compact session serialization and commit all windows on retry", async (t) => {
  const fixture = await createFixture(t, "group");
  fixture.failSend = true;
  await fixture.subscriptions.appendSourceMessage(message("1"));
  fixture.advance(61_000);
  await fixture.subscriptions.appendSourceMessage(message("2", NOTICE + "补充地点：教四。"));
  fixture.advance(61_000);
  await fixture.sessions.requestTrigger(fixture.targetId, "subscription_auto", {});
  await fixture.worker.kick(fixture.targetId);
  const restored = new SessionStore({ filePath: fixture.sessions.filePath });
  await restored.init({ allowedGroups: [fixture.targetId] });
  assert.equal(restored.snapshot(fixture.targetId).failedDelivery.subscriptionConsumptions[0].collectionIds.length, 2);
  fixture.sessions = restored;
  fixture.worker.store = restored;
  fixture.failSend = false;
  await restored.requestTrigger(fixture.targetId, "retry", {});
  await fixture.worker.kick(fixture.targetId);
  assert.equal(fixture.calls, 1);
  const state = Object.values(fixture.subscriptions.snapshot().subscriptions)[0].state;
  assert.equal(state.pendingSequences.length, 0);
  assert.ok(state.collections.every((collection) => collection.status === "completed"));
  assert.equal(state.notifiedFingerprints.length, 2);
});

async function createFixture(t, targetType) {
  const directory = await mkdtemp(join(tmpdir(), "crc-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = { now: START, calls: 0, sends: 0, failSend: false, targetId: targetType === "private" ? "100000001" : "12345", reply: { notify: true, urgency: "normal", reply: "课程通知已送达。", ambiguity: "", actions: [] } };
  fixture.advance = (ms) => { fixture.now += ms; };
  fixture.sessions = new SessionStore({ filePath: join(directory, "sessions.json") });
  await fixture.sessions.init({ allowedGroups: [fixture.targetId] });
  await fixture.sessions.setThread(fixture.targetId, "persistent-thread", { bootstrapComplete: true });
  fixture.subscriptions = new SubscriptionStore({ filePath: join(directory, "subscriptions.json"), clock: () => new Date(fixture.now) });
  await fixture.subscriptions.init();
  await fixture.subscriptions.upsertSubscription({ targetType, targetId: fixture.targetId, sourceGroupId: "54321", mode: "AUTO", collectionDelayMinutes: 1 });
  const send = async () => { fixture.sends++; if (fixture.failSend) throw new Error("QQ unavailable"); return { ok: true, status: 200 }; };
  const Worker = targetType === "group" ? GroupWorker : PrivateWorker;
  fixture.worker = new Worker({ store: fixture.sessions, subscriptionStore: fixture.subscriptions,
    codex: { startThread: async () => assert.fail("must reuse thread"), resumeThread: async () => {}, runTurn: async () => { fixture.calls++; return { text: JSON.stringify(fixture.reply), threadId: "persistent-thread", turnId: "turn-" + fixture.calls }; } },
    oneBot: { sendGroupMessage: send, sendPrivateMessage: send }, mediaManager: { removeMessages: async () => {} },
    fileManager: { resolveRequests: async () => [] }, triggerManager: { reconsiderPending: async () => {} }
  });
  fixture.submit = async (item) => {
    await fixture.subscriptions.appendSourceMessage(item);
    fixture.advance(61_000);
    await fixture.sessions.requestTrigger(fixture.targetId, "subscription_auto", {});
    await fixture.worker.kick(fixture.targetId);
  };
  return fixture;
}

function solidBmp(width, height) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowBytes * height;
  const output = Buffer.alloc(54 + pixelBytes);
  output.fill(0x78, 54);
  output.write("BM", 0, "ascii");
  output.writeUInt32LE(output.length, 2);
  output.writeUInt32LE(54, 10);
  output.writeUInt32LE(40, 14);
  output.writeInt32LE(width, 18);
  output.writeInt32LE(height, 22);
  output.writeUInt16LE(1, 26);
  output.writeUInt16LE(24, 28);
  output.writeUInt32LE(pixelBytes, 34);
  return output;
}

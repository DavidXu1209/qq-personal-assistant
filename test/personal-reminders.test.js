import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePersonalTurn } from "../src/automation/personal-turn.js";
import { QqReminderScheduler } from "../src/automation/qq-reminder-scheduler.js";
import { ICloudCalDavClient } from "../src/automation/icloud-caldav.js";
import { PrivateWorker } from "../src/qq/private-worker.js";
import { SessionStore } from "../src/storage/session-store.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";
import { handlePersonalCommand, isPersonalCommand } from "../src/automation/personal-commands.js";

test("Shanghai date rules and persisted reminders survive failed delivery and restart", async () => {
  const parse = (when) => parsePersonalTurn(JSON.stringify({ reply: "提交作业", actions: [{ type: "reminder", title: "作业", when, end: null, location: "", notes: "" }] }), { messageIds: ["message-1"] }).actions[0];
  assert.equal(parse("2026-10-08").start, "2026-10-08T01:00:00.000Z");
  assert.equal(parse("2026-10-08T14:00+08:00").reminderAt, "2026-10-08T05:50:00.000Z");
  for (const invalid of ["2026-02-30", "2026-10-08T24:00+08:00", "tomorrow", "2026-10-08T14:00Z"]) assert.throws(() => parse(invalid), /无效/);
  const root = await mkdtemp(join(tmpdir(), "qq-reminder-check-"));
  try {
    const filePath = join(root, "reminders.json");
    let fail = true;
    let sent = 0;
    const oneBot = { async sendPrivateMessage() { if (fail) throw new Error("offline"); sent++; return { ok: true }; } };
    const scheduler = new QqReminderScheduler({ filePath, oneBot, ownerId: "test-owner" });
    await scheduler.init();
    const action = parse("2026-10-08");
    await Promise.all([scheduler.add(action), scheduler.add({ ...action, actionId: "second", title: "另一份作业" })]);
    await assert.rejects(scheduler.deliverDue(Date.parse(action.start)), /offline/);
    assert.equal(JSON.parse(await readFile(filePath, "utf8"))[0].status, "pending");
    fail = false;
    const recovered = new QqReminderScheduler({ filePath, oneBot, ownerId: "test-owner" });
    await recovered.init();
    await recovered.deliverDue(Date.parse(action.start));
    await recovered.add(action);
    await recovered.deliverDue(Date.parse(action.start));
    assert.equal(sent, 2);
    assert.equal(recovered.items.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("iCloud discovery, Unicode calendar text and credential redirect boundary", async () => {
  const requests = [];
  const responses = [
    [207, '<d:current-user-principal xmlns:d="DAV:"><d:href>/principal/</d:href></d:current-user-principal>'],
    [207, '<c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:d="DAV:"><d:href>/home/</d:href></c:calendar-home-set>'],
    [207, '<d:multistatus xmlns:d="DAV:"/>'], [201, ""], [201, ""]
  ];
  const client = new ICloudCalDavClient({ username: "test@example.invalid", password: "fake-test-password", fetchImpl: async (url, options) => {
    requests.push({ url: String(url), ...options });
    const [status, body] = responses.shift();
    return new Response(body, { status });
  } });
  const action = { actionId: "test-event", title: "中文😀".repeat(60), notes: "第一行\rSUMMARY:不得注入属性", start: "2026-10-08T06:00:00Z", end: "2026-10-08T06:30:00Z", reminderAt: "2026-10-08T05:50:00Z" };
  await client.execute(action);
  assert.deepEqual(requests.map(r => r.method), ["PROPFIND", "PROPFIND", "PROPFIND", "MKCALENDAR", "PUT"]);
  assert.match(new URL(requests[3].url).pathname, /\/[a-f\d-]{36}\/$/);
  assert.ok(requests[3].body.includes('c:comp name="VEVENT"'));
  const body = requests.at(-1).body;
  assert.ok(body.includes("TRIGGER:-PT10M"));
  assert.ok(body.replace(/\r\n /g, "").includes(`SUMMARY:${action.title}\r\n`));
  assert.ok(body.replace(/\r\n /g, "").includes("DESCRIPTION:第一行\\nSUMMARY:不得注入属性"));
  for (const line of body.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75);
  const originalUrl = requests.at(-1).url;
  responses.push([200, ""]);
  await client.remove(action);
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(requests.at(-1).url, originalUrl, "delete only the exact event created by this bot");
  responses.push([403, ""]);
  await assert.rejects(client.remove(action), /删除失败/);
  let calls = 0;
  const blocked = new ICloudCalDavClient({ username: "fake", password: "fake", fetchImpl: async () => { calls++; return new Response("", {status:302,headers:{location:"https://example.invalid/collect"}}); } });
  await assert.rejects(blocked.execute(action), /拒绝/);
  assert.equal(calls, 1);
  const chinaRequests = [];
  const china = new ICloudCalDavClient({ username: "fake", password: "fake", fetchImpl: async (url) => {
    chinaRequests.push(String(url));
    return chinaRequests.length === 1
      ? new Response("", { status: 302, headers: { location: "https://p211-caldav.icloud.com.cn/principal/" } })
      : new Response("", { status: 207 });
  } });
  assert.equal((await china.request("https://caldav.icloud.com/", "PROPFIND")).status, 207);
  assert.equal(chinaRequests.length, 2);
  for (const url of ["https://icloud.com.cn.evil.invalid/", "https://evilicloud.com.cn/", "http://p211-caldav.icloud.com.cn/", "https://caldav.icloud.com:8443/"]) {
    await assert.rejects(china.request(url, "PROPFIND"), /拒绝/);
  }
  assert.equal(chinaRequests.length, 2, "blocked addresses never receive credentials");
});

test("owner extraction keeps read-only permissions and QQ reminders when iCloud is unavailable", async () => {
  const previousMode = process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE;
  process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE = "1";
  const root = await mkdtemp(join(tmpdir(), "qq-owner-check-"));
  try {
    const store = new SessionStore({ filePath: join(root, "sessions.json"), defaultCodexConfig: { permissionMode: "dangerFullAccess", calendarRemindersEnabled: true } });
    await store.init({ allowedGroups: [OWNER_QQ_ID] });
    await store.appendMessage({ groupId: OWNER_QQ_ID, senderId: OWNER_QQ_ID, messageId: "owner-1", text: "2026年10月8日下午2点提交作业", trust: "OWNER" });
    await store.requestTrigger(OWNER_QQ_ID, "mention");
    const work = await store.beginWork(OWNER_QQ_ID);
    let queued = 0;
    let delivered = "";
    const worker = new PrivateWorker({ store, mediaManager: { async removeMessages() {} },
      oneBot: { async sendPrivateMessage(id, text) { assert.equal(id, OWNER_QQ_ID); delivered = text; return {ok:true}; } },
      codex: { async startThread() { return "fake-thread"; }, async runTurn(request) {
        assert.equal(request.turnSandbox.type, "readOnly");
        assert.equal(request.outputSchema.type, "object");
        return { turnId: "fake-turn", text: JSON.stringify({ reply: "10月8日提交作业", actions: [{ type: "reminder", title: "作业", when: "2026-10-08T14:00+08:00", end: null, notes: "", location: "" }] }) };
      } },
      reminderScheduler: { async add() { queued++; } },
      automationClient: { async execute() { throw new Error("未设置专用密码"); } }
    });
    await worker.runAgent(OWNER_QQ_ID, work);
    assert.equal(queued, 1);
    assert.match(delivered, /已设置 QQ 提醒/);
    assert.match(delivered, /iCloud 写入失败/);
    assert.doesNotMatch(delivered, /已加入 iCloud/);
  } finally {
    if (previousMode === undefined) delete process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE; else process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE = previousMode;
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate notifications, ID-based edits, cancellation and calendar failures persist safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manage-check-"));
  try {
    const scheduler = new QqReminderScheduler({ filePath: join(root, "reminders.json"), ownerId: "owner", oneBot: { async sendPrivateMessage() { return { ok: true }; } } });
    await scheduler.init();
    const action = { actionId: "abcdef123456abcdef123456", type: "calendar", title: "班会", start: "2099-10-08T06:00:00Z", end: "2099-10-08T07:00:00Z", reminderAt: "2099-10-08T05:50:00Z", location: "A101" };
    assert.equal((await scheduler.add(action)).created, true);
    assert.equal((await scheduler.add({ ...action, actionId: "123456abcdef123456abcdef", title: "班 会" })).created, false);
    assert.equal(scheduler.items.length, 1);
    const message = text => ({ text, trust: "OWNER" });
    const commands = { scheduler, calendar: { async execute() { throw new Error("calendar offline"); }, async remove() { throw new Error("calendar offline"); } }, status: async () => "QQ未连接" };
    assert.equal(isPersonalCommand({ text: "取消提醒 abcdef12", trust: "UNTRUSTED_FORWARDED" }), false);
    assert.equal(isPersonalCommand({ ...message("取消提醒 abcdef12"), attachments: [{ type: "forward" }] }), false);
    assert.match(await handlePersonalCommand(message("查看提醒"), commands), /abcdef12/);
    assert.match(await handlePersonalCommand(message("修改提醒 abcdef12 2099-10-09 15:00"), commands), /已修改 QQ 提醒/);
    assert.equal(scheduler.items[0].start, "2099-10-09T07:00:00.000Z");
    assert.equal(scheduler.items[0].end, "2099-10-09T08:00:00.000Z");
    assert.equal((await scheduler.add(action)).created, false);
    assert.equal(scheduler.items[0].start, "2099-10-09T07:00:00.000Z", "old forwarding must not undo an edit");
    const before = scheduler.items[0].start;
    assert.match(await handlePersonalCommand(message("修改提醒 abcdef12 2099-02-30 14:00"), commands), /未完成/);
    assert.equal(scheduler.items[0].start, before);
    assert.match(await handlePersonalCommand(message("取消提醒 abcdef12"), commands), /已取消 QQ 提醒/);
    assert.equal(scheduler.items[0].status, "cancelled");
    assert.equal(scheduler.items[0].calendarStatus, "failed");
    assert.equal(scheduler.list().length, 0);
    assert.equal((await scheduler.add(action)).action.status, "cancelled");
    assert.equal(await handlePersonalCommand(message("状态"), commands), "QQ未连接");
    const restarted = new QqReminderScheduler({ filePath: scheduler.filePath, ownerId: "owner" });
    await restarted.init();
    assert.equal(restarted.items[0].status, "cancelled");
    assert.equal(restarted.items[0].calendarError, "calendar offline");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner reminder management bypasses model quota without consuming earlier pending messages", async () => {
  const previous = process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE;
  process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE = "1";
  const root = await mkdtemp(join(tmpdir(), "qq-quota-command-check-"));
  try {
    const store = new SessionStore({ filePath: join(root, "sessions.json") });
    await store.init({ allowedGroups: [OWNER_QQ_ID] });
    await store.appendMessage({ groupId: OWNER_QQ_ID, senderId: OWNER_QQ_ID, messageId: "old-input", text: "待整理资料", trust: "OWNER" });
    const message = await store.appendMessage({ groupId: OWNER_QQ_ID, senderId: OWNER_QQ_ID, messageId: "command", text: "查看提醒", trust: "OWNER" });
    store.state.groups[OWNER_QQ_ID].lastError = "429 2099-10-07 12:00:00 UTC+8";
    await store.requestTrigger(OWNER_QQ_ID, "control", message);
    let reply = "";
    const worker = new PrivateWorker({ store, codex: { async runTurn() { assert.fail("must not call model"); } },
      reminderScheduler: { list() { return []; } }, oneBot: { async sendPrivateMessage(_id, text) { reply = text; return { ok: true }; } } });
    await worker.runControl(OWNER_QQ_ID, await store.beginWork(OWNER_QQ_ID));
    assert.match(reply, /当前没有提醒/);
    assert.ok(store.rateLimitUntil(OWNER_QQ_ID) > Date.now(), "local commands must not clear the model quota limit");
    assert.deepEqual(store.snapshot(OWNER_QQ_ID).pendingMessages.map(m => m.messageId), ["old-input"]);
  } finally {
    if (previous === undefined) delete process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE; else process.env.CODEX_REMOTE_CONTACT_PERSONAL_MODE = previous;
    await rm(root, { recursive: true, force: true });
  }
});

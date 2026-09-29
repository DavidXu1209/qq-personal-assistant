import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { QzoneCoordinator, isDeletedQzoneFeedError, normalizeFeeds, parseEngagementDecisions, parseQzonePostDirectives } from "../src/qq/qzone-coordinator.js";
import { QzoneStore } from "../src/qq/qzone-store.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";
import { SessionStore } from "../src/storage/session-store.js";
import { createLiveConversationTools } from "../src/qq/live-conversation.js";

async function withStore(callback) {
  const dir = await mkdtemp(join(tmpdir(), "crc-qzone-test-"));
  try {
    const filePath = join(dir, "qzone.json");
    const store = new QzoneStore({ filePath });
    await store.init();
    return await callback(store, filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("QQ Space settings and attempted actions persist without a duplicate retry", async () => {
  await withStore(async (store, filePath) => {
    assert.equal(store.publicState().autoPostEnabled, false);
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true, autoEngageEnabled: true });
    assert.equal(await store.claimAction("post:slot", "scheduled-post"), true);
    assert.equal(await store.claimAction("post:slot", "scheduled-post"), false);
    const reloaded = new QzoneStore({ filePath });
    await reloaded.init();
    assert.equal(reloaded.publicState().targetId, "200000002");
    assert.equal(reloaded.hasAction("post:slot"), true);
    await reloaded.finishAction("post:slot", { status: "done", message: "已发布" });
    assert.ok(reloaded.publicState().lastPostAt);
  });
});

test("only explicit deleted-feed errors become terminal, and shared dedupe skips later interactions", async () => {
  assert.equal(isDeletedQzoneFeedError(new Error("该动态已删除")), true);
  assert.equal(isDeletedQzoneFeedError(new Error("请求超时")), false);
  await withStore(async (store, filePath) => {
    const calls = [];
    const coordinator = new QzoneCoordinator({ store, oneBot: {
      likeQzone: async () => { calls.push("like"); throw new Error("该说说不存在"); },
      commentQzone: async () => { calls.push("comment"); }
    } });
    const action = { type: "like", uin: "123456789", tid: "gone", abstime: 123 };
    assert.equal((await coordinator.executeEngagement(action, "group:200000002", () => {})).status, "unavailable");
    assert.equal((await coordinator.executeEngagement({ ...action, type: "comment", content: "你好" }, "group:200000002", () => {})).status, "unavailable");
    assert.deepEqual(calls, ["like"]);
    assert.equal(store.snapshot().actions["unavailable:123456789:gone"].status, "unavailable");
    const reloaded = new QzoneStore({ filePath });
    await reloaded.init();
    assert.equal(reloaded.hasAction("unavailable:123456789:gone"), true);
  });
});

test("OWNER ordinary turn can read real feeds, like and comment once without advancing the scheduled cursor", async () => {
  await withStore(async (qzoneStore, filePath) => {
    const sessionStore = new SessionStore({ filePath: join(dirname(filePath), "sessions.json") });
    await sessionStore.init({ allowedGroups: ["200000002"] });
    const message = await sessionStore.appendMessage({ groupId: "200000002", messageId: "101", senderId: OWNER_QQ_ID,
      senderName: "OWNER", text: "老代看看动态", trust: "OWNER", mentionedBot: true,
      timestamp: "2026-09-22T02:00:00.000Z", displayTime: "10:00" });
    await sessionStore.requestTrigger("200000002", "mention", message);
    await sessionStore.beginWork("200000002");
    const calls = [];
    const feed = { uin: "123456789", key: "tid-1", time: 1789990000, nickname: "好友", html: "今天做了件好事" };
    const oneBot = {
      async getQzoneFeedPage(pageNum, count) { calls.push(["read", pageNum, count]); return { feeds: [feed], hasMore: false }; },
      async likeQzone(action) { calls.push(["like", action]); },
      async commentQzone(action) { calls.push(["comment", action]); }
    };
    const qzone = new QzoneCoordinator({ store: qzoneStore, oneBot,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] } });
    const context = createLiveConversationTools({ store: sessionStore, targetId: "200000002", targetType: "group",
      oneBot, qzone, trigger: { reason: "mention", trust: "OWNER", messageId: "101" }, triggerMessages: [message],
      security: { allowQqFiles: false }, initialImageSequence: message.sequence,
      renderMessages: (messages) => messages.map((item) => item.text).join("\n") });
    const active = { onDelta() {} };
    assert.equal(context.allowQzoneFeed, true);
    assert.equal((await context.liveTool("engage_qzone_feed", { type: "like", uin: feed.uin, tid: feed.key }, active)).isError, true);
    await context.liveTool("read_messages", {}, active);
    assert.equal((await context.liveTool("engage_qzone_feed", { type: "like", uin: feed.uin, tid: feed.key }, active)).isError, true);
    const read = await context.liveTool("read_qzone_feeds", {}, active);
    assert.equal(read.isError, false);
    assert.equal(JSON.parse(read.content[0].text).feeds[0].tid, feed.key);
    assert.equal((await context.liveTool("engage_qzone_feed", { type: "like", uin: feed.uin, tid: feed.key }, active)).isError, false);
    assert.equal((await context.liveTool("engage_qzone_feed", { type: "comment", uin: feed.uin, tid: feed.key, content: "这事挺好" }, active)).isError, false);
    assert.equal((await context.liveTool("engage_qzone_feed", { type: "like", uin: feed.uin, tid: feed.key }, active)).isError, false);
    assert.deepEqual(calls.map((item) => item[0]), ["read", "like", "comment"]);
    assert.equal(qzoneStore.publicState().lastSeenFeedTimeMs, null);
    assert.equal(qzoneStore.publicState().lastScanAt, null);
    assert.equal(context.qzoneActionCount, 2);
    assert.equal(sessionStore.snapshot("200000002").pendingMessages.length, 1);
    await sessionStore.completeLiveConversation("200000002", { lastReadSequence: context.lastReadSequence,
      consumeReadWithoutReply: context.qzoneActionCount > 0 });
    assert.equal(sessionStore.snapshot("200000002").pendingMessages.length, 0);
  });
});

test("non-OWNER, stale OWNER and other conversations cannot browse or engage QQ Space", async () => {
  await withStore(async (store) => {
    let reads = 0;
    const coordinator = new QzoneCoordinator({ store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      oneBot: { async getQzoneFeedPage() { reads += 1; return { feeds: [], hasMore: false }; } } });
    const base = { targetType: "group", targetId: "200000002", messages: [{ senderId: OWNER_QQ_ID, messageId: "101", text: "老代看看动态" }],
      trigger: { reason: "mention", trust: "OWNER", messageId: "101" } };
    assert.equal(coordinator.isOwnerFeedTurn(base.messages, base.trigger, base.targetType, base.targetId), true);
    await assert.rejects(coordinator.readManualFeeds({ ...base, trigger: { ...base.trigger, trust: "UNTRUSTED" } }), /只有 OWNER/);
    await assert.rejects(coordinator.readManualFeeds({ ...base, trigger: { ...base.trigger, messageId: "old" } }), /只有 OWNER/);
    await assert.rejects(coordinator.readManualFeeds({ ...base, targetId: "999999999" }), /只有 OWNER/);
    assert.equal(reads, 0);
  });
});

test("a newly read OWNER request unlocks Space during a member-triggered chat, but a quote does not", async () => {
  await withStore(async (qzoneStore, filePath) => {
    const sessionStore = new SessionStore({ filePath: join(dirname(filePath), "sessions.json") });
    await sessionStore.init({ allowedGroups: ["200000002"] });
    const member = await sessionStore.appendMessage({ groupId: "200000002", messageId: "201",
      senderId: "400000002", senderName: "成员", text: "老代看看这个", trust: "UNTRUSTED", source: "qq" });
    await sessionStore.requestTrigger("200000002", "mention", member);
    await sessionStore.beginWork("200000002");
    const calls = [];
    const oneBot = {
      getQzoneFeedPage: async () => {
        calls.push("read");
        return { feeds: [{ uin: "123456789", key: "actual", time: 1789990000, html: "近况" }], hasMore: false };
      },
      publishQzone: async () => { calls.push("post"); }
    };
    const qzone = new QzoneCoordinator({ store: qzoneStore, oneBot,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] } });
    const context = createLiveConversationTools({ store: sessionStore, targetId: "200000002",
      targetType: "group", oneBot, qzone, trigger: { reason: "mention", trust: "UNTRUSTED", messageId: "201" },
      triggerMessages: [member], security: { allowQqFiles: false }, initialImageSequence: member.sequence,
      renderMessages: (messages) => messages.map((item) => item.text).join("\n") });
    const active = { turnId: "turn", onDelta() {} };
    await context.liveTool("read_messages", {}, active);
    assert.equal((await context.liveTool("read_qzone_feeds", {}, active)).isError, true);
    await sessionStore.appendMessage({ groupId: "200000002", messageId: "202", senderId: "400000002",
      senderName: "成员", text: "引用了老板", trust: "UNTRUSTED", source: "qq",
      quotedMessage: { groupId: "200000002", messageId: "old", senderId: OWNER_QQ_ID,
        text: "老代看看动态", trust: "OWNER", source: "qq", sequence: 1 } });
    await context.liveTool("read_messages", {}, active);
    assert.equal((await context.liveTool("read_qzone_feeds", {}, active)).isError, true);
    await sessionStore.appendMessage({ groupId: "200000002", messageId: "203", senderId: OWNER_QQ_ID,
      senderName: "OWNER", text: "老代看看动态", trust: "OWNER", source: "qq" });
    assert.match((await context.liveTool("read_messages", {}, active)).content[0].text, /群聊文件执行权限标签不限制这些 QQ 动态工具/);
    assert.equal((await context.liveTool("read_qzone_feeds", {}, active)).isError, false);
    assert.equal((await context.liveTool("post_qzone", { content: "不能因此发布" }, active)).isError, true);
    await sessionStore.appendMessage({ groupId: "200000002", messageId: "204", senderId: OWNER_QQ_ID,
      senderName: "OWNER", text: "老代发一条空间动态", trust: "OWNER", source: "qq" });
    await context.liveTool("read_messages", {}, active);
    assert.equal((await context.liveTool("post_qzone", { content: "经 OWNER 授权" }, active)).isError, false);
    assert.deepEqual(calls, ["read", "post"]);
  });
});

test("scheduled Space turn shares chat tools without consuming pending messages", async () => {
  await withStore(async (qzoneStore, filePath) => {
    const sessionStore = new SessionStore({ filePath: join(dirname(filePath), "sessions.json") });
    await sessionStore.init({ allowedGroups: ["200000002"] });
    await sessionStore.appendMessage({ groupId: "200000002", messageId: "301", senderId: "400000002",
      senderName: "成员", text: "待处理的群消息", trust: "UNTRUSTED", source: "qq" });
    await qzoneStore.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true });
    const sent = [];
    const oneBot = {
      publishQzone: async () => { sent.push("post"); },
      sendGroupMessage: async (_group, text) => { sent.push(text); return { ok: true, body: { data: { message_id: 302 } } }; },
      getQzoneFeedPage: async () => ({ feeds: [], hasMore: false })
    };
    let coordinator;
    const worker = {
      codex: { supportsQqMcp: true, supportsSystemPrompt: true },
      createScheduledToolContext: (id, qzoneActions) => createLiveConversationTools({
        store: sessionStore, targetId: id, targetType: "group", oneBot, qzone: coordinator,
        trigger: { reason: "qzone_scheduled", trust: "SYSTEM" }, triggerMessages: [],
        security: { allowQqFiles: false }, initialImageSequence: 1,
        renderMessages: (messages) => messages.map((item) => item.text).join("\n"),
        scheduledTask: true, qzoneActions
      }),
      runQzoneTurn: async (_id, prompt, { qqToolContext: context }) => {
        assert.doesNotMatch(prompt, /待处理的群消息/);
        assert.equal((await context.liveTool("post_qzone", { content: "定时动态" })).isError, false);
        const read = await context.liveTool("read_messages");
        assert.match(read.content[0].text, /待处理的群消息/);
        assert.equal((await context.liveTool("send_message", { text: "顺便回复" })).isError, false);
        return { text: "" };
      }
    };
    coordinator = new QzoneCoordinator({ store: qzoneStore, oneBot,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] }, groupWorker: worker });
    await coordinator.runScheduledPost(coordinator.boundTarget(), "2026-09-29T08:00");
    assert.deepEqual(sent, ["post", "顺便回复"]);
    assert.equal(sessionStore.snapshot("200000002").pendingMessages.length, 1);
    assert.equal(sessionStore.snapshot("200000002").lastCompletedReply.text, "顺便回复");
    assert.equal(qzoneStore.snapshot().actions["post:2026-09-29T08:00"].status, "done");
  });
});

test("scheduled feed scan uses the shared reader and engagement tools while chat stays queued", async () => {
  await withStore(async (qzoneStore, filePath) => {
    const sessionStore = new SessionStore({ filePath: join(dirname(filePath), "sessions.json") });
    await sessionStore.init({ allowedGroups: ["200000002"] });
    await sessionStore.appendMessage({ groupId: "200000002", messageId: "401", senderId: "400000002",
      senderName: "成员", text: "还没处理的消息", trust: "UNTRUSTED", source: "qq" });
    await qzoneStore.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    await qzoneStore.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const calls = [];
    const oneBot = {
      getQzoneFeedPage: async () => ({ feeds: [
        { uin: "123456789", key: "new", time: 1789950060, html: "刚发的动态" },
        { uin: "123456789", key: "old", time: 1789950000, html: "旧动态" }
      ], hasMore: false }),
      likeQzone: async () => { calls.push("like"); },
      sendGroupMessage: async (_group, text) => { calls.push(text); return { ok: true }; }
    };
    let coordinator;
    const worker = {
      codex: { supportsQqMcp: true, supportsSystemPrompt: true },
      createScheduledToolContext: (id, qzoneActions) => createLiveConversationTools({
        store: sessionStore, targetId: id, targetType: "group", oneBot, qzone: coordinator,
        trigger: { reason: "qzone_scheduled", trust: "SYSTEM" }, triggerMessages: [],
        security: { allowQqFiles: false }, initialImageSequence: 1,
        renderMessages: (messages) => messages.map((item) => item.text).join("\n"),
        scheduledTask: true, qzoneActions
      }),
      runQzoneTurn: async (_id, prompt, { qqToolContext: context }) => {
        assert.doesNotMatch(prompt, /还没处理的消息/);
        const read = await context.liveTool("read_qzone_feeds");
        const feeds = JSON.parse(read.content[0].text).feeds;
        assert.deepEqual(feeds.map((feed) => feed.tid), ["new"]);
        assert.equal((await context.liveTool("engage_qzone_feed", { type: "like", uin: feeds[0].uin,
          tid: feeds[0].tid })).isError, false);
        assert.match((await context.liveTool("read_messages")).content[0].text, /还没处理的消息/);
        assert.equal((await context.liveTool("send_message", { text: "看完动态了" })).isError, false);
        return { text: "" };
      }
    };
    coordinator = new QzoneCoordinator({ store: qzoneStore, oneBot,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] }, groupWorker: worker });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-29T09:00");
    assert.deepEqual(calls, ["like", "看完动态了"]);
    assert.equal(sessionStore.snapshot("200000002").pendingMessages.length, 1);
    assert.equal(qzoneStore.snapshot().actions["scan:2026-09-29T09:00"].status, "done");
  });
});

test("OWNER may browse from a managed private chat without changing the scheduled binding", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002" });
    const coordinator = new QzoneCoordinator({ store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [{ groupId: OWNER_QQ_ID, replyEnabled: true }] },
      oneBot: { async getQzoneFeedPage() { return { feeds: [{ uin: "123456789", key: "private-feed", time: 1789990000, html: "近况" }], hasMore: false }; } } });
    const page = await coordinator.readManualFeeds({ targetType: "private", targetId: OWNER_QQ_ID,
      messages: [{ senderId: OWNER_QQ_ID, messageId: "private-1", text: "看看动态" }],
      trigger: { reason: "mention", trust: "OWNER", messageId: "private-1" } });
    assert.equal(page.feeds[0].tid, "private-feed");
    assert.equal(store.publicState().targetId, "200000002");
    assert.equal(store.publicState().lastSeenFeedTimeMs, null);
  });
});

test("QQ Space directives are removed from QQ text and feed decisions stay within fresh actual feeds", () => {
  const parsed = parseQzonePostDirectives('你好\n[[qq_zone_post:{"content":"今晚散步","visibility":4}]]');
  assert.equal(parsed.text, "你好");
  assert.deepEqual(parsed.posts, [{ content: "今晚散步", visibility: 4 }]);
  const feeds = normalizeFeeds([{ uin: "123456789", key: "tid123456", time: 1789990000, nickname: "好友", html: "<b>今天很好</b>" }]);
  assert.equal(feeds[0].text, "今天很好");
  const actions = parseEngagementDecisions(JSON.stringify({ actions: [
    { type: "like", uin: "123456789", tid: "tid123456" },
    { type: "comment", uin: "123456789", tid: "tid123456", content: "很棒！" },
    { type: "like", uin: "999999999", tid: "fake1234" }
  ] }), feeds);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].abstime, 1789990000);
});

test("manual QQ Space posting works in every managed Agent chat but only for the current OWNER request", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002" });
    let posts = 0;
    const sent = [];
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }, { groupId: "200000003", replyEnabled: true }] },
      privateStore: { listGroups: () => [{ groupId: OWNER_QQ_ID, replyEnabled: true }, { groupId: "123456789", replyEnabled: true }] },
      oneBot: { publishQzone: async (content, options) => { posts += 1; sent.push({ content, options }); } }
    });
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "帮我发动态" }, "group", "200000002"), true);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "帮我发动态" }, "group", "200000003"), true);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "帮我看看好友动态" }, "group", "200000003"), true);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "翻阅动态" }, "group", "200000003"), true);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "先别点赞动态" }, "group", "200000003"), false);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "先不要发动态" }, "group", "200000003"), false);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: "123456789", text: "帮我发动态" }, "group", "200000002"), false);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ senderId: OWNER_QQ_ID, text: "帮我发动态" }, "group", "999999999"), false);
    const input = {
      targetType: "group", targetId: "200000002", turnId: "turn-1",
      text: '发好了\n[[qq_zone_post:{"content":"今晚散步","visibility":64}]]',
      trigger: { trust: "OWNER", messageId: "m2" },
      messages: [{ senderId: OWNER_QQ_ID, messageId: "m1", text: "帮我发动态" }, { senderId: OWNER_QQ_ID, messageId: "m2", text: "你觉得呢" }]
    };
    const denied = await coordinator.executeManual(input);
    assert.equal(posts, 0);
    assert.equal(denied.text, "发好了");
    assert.match(denied.notices[0], /仅允许 OWNER/);
    input.messages[1].text = "帮我发动态";
    const done = await coordinator.executeManual(input);
    assert.equal(posts, 1);
    assert.deepEqual(sent[0], { content: "今晚散步", options: undefined });
    assert.match(done.notices[0], /已用老代/);
    await coordinator.executeManual(input);
    assert.equal(posts, 1);

    const anotherGroup = { ...input, targetId: "200000003", trigger: { trust: "OWNER", messageId: "m3" }, messages: [{ senderId: OWNER_QQ_ID, messageId: "m3", text: "帮我发动态" }] };
    assert.equal(coordinator.isOwnerPostTurn(anotherGroup.messages, anotherGroup.trigger, "group", anotherGroup.targetId), true);
    assert.match((await coordinator.executeManual(anotherGroup)).notices[0], /已用老代/);
    assert.equal(posts, 2);
    const anotherPrivate = { ...anotherGroup, targetType: "private", targetId: "123456789", trigger: { trust: "OWNER", messageId: "m4" }, messages: [{ senderId: OWNER_QQ_ID, messageId: "m4", text: "帮我发动态" }] };
    assert.match((await coordinator.executeManual(anotherPrivate)).notices[0], /已用老代/);
    assert.equal(posts, 3);
    const otherMember = { ...anotherGroup, trigger: { trust: "UNTRUSTED", messageId: "m5" }, messages: [{ senderId: "123456789", messageId: "m5", text: "帮我发动态" }] };
    assert.match((await coordinator.executeManual(otherMember)).notices[0], /仅允许 OWNER/);
    assert.equal(posts, 3);
    const unknownGroup = { ...anotherGroup, targetId: "999999999", trigger: { trust: "OWNER", messageId: "m6" }, messages: [{ senderId: OWNER_QQ_ID, messageId: "m6", text: "帮我发动态" }] };
    assert.match((await coordinator.executeManual(unknownGroup)).notices[0], /仅允许 OWNER/);
    assert.equal(posts, 3);
  });
});

test("live OWNER mention may autonomously post, but member and negated turns may not", async () => {
  await withStore(async (store) => {
    let posts = 0;
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      oneBot: { publishQzone: async () => { posts += 1; } }
    });
    const base = {
      targetType: "group", targetId: "200000002", turnId: "live-1",
      text: '[[qq_zone_post:{"content":"今天的一个想法"}]]', allowAutonomousOwnerPost: true,
      trigger: { reason: "mention", trust: "OWNER", messageId: "owner-1" },
      messages: [{ senderId: OWNER_QQ_ID, messageId: "owner-1", text: "老代，你怎么看？" }]
    };
    assert.equal(coordinator.isOwnerAutonomousTurn(base.messages, base.trigger, base.targetType, base.targetId), true);
    assert.match((await coordinator.executeManual(base)).notices[0], /已用老代/);
    assert.equal(posts, 1);
    assert.match((await coordinator.executeManual({ ...base, trigger: { ...base.trigger, reason: "message_count" }, turnId: "live-2" })).notices[0], /仅允许 OWNER/);
    assert.match((await coordinator.executeManual({ ...base, trigger: { ...base.trigger, trust: "UNTRUSTED" }, turnId: "live-3" })).notices[0], /仅允许 OWNER/);
    assert.match((await coordinator.executeManual({ ...base, messages: [{ ...base.messages[0], text: "先不要发动态" }], turnId: "live-4" })).notices[0], /仅允许 OWNER/);
    assert.equal(posts, 1);
  });
});

test("OWNER can request a new post with natural editorial wording without authorizing ordinary discussion", async () => {
  await withStore(async (store) => {
    let posts = 0;
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000001", replyEnabled: true }] },
      oneBot: { publishQzone: async () => { posts += 1; } }
    });
    const owner = (text) => ({ senderId: OWNER_QQ_ID, messageId: "owner-1", text });
    assert.equal(coordinator.shouldWakeForOwnerRequest(owner("老代在动态里锐评一下强尼手银"), "group", "200000001"), true);
    assert.equal(coordinator.shouldWakeForOwnerRequest(owner("老代，帮我在说说里吐槽一下这事"), "group", "200000001"), true);
    for (const text of [
      "老代不要在动态里锐评强尼手银",
      "老代在动态里别锐评强尼手银",
      "你觉得在动态里锐评强尼手银合适吗",
      "老代去强尼手银的动态里锐评一下"
    ]) {
      assert.equal(coordinator.shouldWakeForOwnerRequest(owner(text), "group", "200000001"), false, text);
    }
    assert.equal(coordinator.shouldWakeForOwnerRequest(owner("老代看看强尼手银的动态"), "group", "200000001"), true);
    assert.equal(coordinator.isOwnerAutonomousTurn([owner("老代看看强尼手银的动态")],
      { reason: "mention", trust: "OWNER", messageId: "owner-1" }, "group", "200000001"), false);
    assert.equal(coordinator.shouldWakeForOwnerRequest({ ...owner("老代在动态里锐评一下强尼手银"), senderId: "400000002" }, "group", "200000001"), false);
    const input = {
      targetType: "group", targetId: "200000001", turnId: "editorial-turn",
      text: '写好了\n[[qq_zone_post:{"content":"今晚锐评一下强尼手银"}]]',
      trigger: { trust: "OWNER", messageId: "owner-1" },
      messages: [owner("老代在动态里锐评一下强尼手银")]
    };
    const result = await coordinator.executeManual(input);
    assert.equal(posts, 1);
    assert.match(result.notices[0], /已用老代/);
    await coordinator.executeManual({ ...input, trigger: { trust: "UNTRUSTED", messageId: "owner-2" } });
    assert.equal(posts, 1);
  });
});

test("opening manual posting in all chats does not expose friend feeds outside the bound chat", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002" });
    let feedReads = 0;
    const coordinator = new QzoneCoordinator({ store, oneBot: { getQzoneFeeds: async () => { feedReads += 1; return []; } } });
    const messages = [{ senderId: OWNER_QQ_ID, messageId: "m1", text: "看看好友动态" }];
    const trigger = { trust: "OWNER", messageId: "m1" };
    assert.equal(await coordinator.manualFeedContext(messages, "group", "200000003", trigger), "");
    assert.equal(feedReads, 0);
    assert.match(await coordinator.manualFeedContext(messages, "group", "200000002", trigger), /近期好友动态/);
    assert.equal(feedReads, 1);
    assert.equal(await coordinator.manualFeedContext(messages, "group", "200000002", { trust: "UNTRUSTED", messageId: "m1" }), "");
  });
});

test("hourly feed check uses the selected persistent conversation and handles each slot once", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true, autoEngageEnabled: true });
    let now = new Date("2026-09-21T00:00:00Z"); // 08:00 Shanghai
    const calls = [];
    const feed = { uin: "123456789", key: "tid123456", time: Math.floor(now.getTime() / 1000) - 60, nickname: "好友", html: "新作品" };
    await store.markFeeds(["123456789:older"], { newestFeed: { id: "123456789:older", timeMs: (feed.time - 60) * 1000 } });
    const coordinator = new QzoneCoordinator({
      store, clock: () => now, scheduleTimes: ["08:00", "12:00", "18:00"],
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { runQzoneTurn: async (id, prompt, options) => {
        calls.push(options.trigger);
        return { text: options.trigger === "qzone-post" ? "[[qq_zone_skip]]" : JSON.stringify({ actions: [{ type: "like", uin: feed.uin, tid: feed.key }] }) };
      } },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [feed, { ...feed, key: "older", time: feed.time - 60 }], hasMore: false }), likeQzone: async () => { calls.push("liked"); } }
    });
    await coordinator.tick();
    await coordinator.tick();
    assert.deepEqual(calls, ["qzone-post", "qzone-feed", "liked"]);
    now = new Date("2026-09-21T18:00:00Z"); // 02:00 Shanghai, outside scan window
    await coordinator.tick();
    assert.equal(calls.length, 3);
  });
});

test("scheduled feed activity follows its bound conversation and clears after the check", async () => {
  await withStore(async (store) => {
    const targetId = "123456789";
    await store.configure({ targetType: "private", targetId, autoEngageEnabled: true });
    const now = new Date("2026-09-29T01:00:00Z");
    const feed = { uin: "123456789", key: "new", time: Math.floor(now.getTime() / 1000) - 60, html: "新动态" };
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: (feed.time - 60) * 1000 } });
    let releaseQueue;
    const queue = new Promise((resolve) => { releaseQueue = resolve; });
    const stages = [];
    let coordinator;
    coordinator = new QzoneCoordinator({ store, clock: () => now,
      groupStore: { listGroups: () => [] },
      privateStore: { listGroups: () => [{ groupId: targetId, replyEnabled: true }] },
      privateWorker: { async runQzoneSequence(_id, task) {
        await queue;
        await task(async () => ({ text: '{"actions":[]}' }));
      } },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [feed], hasMore: false }) },
      onActivityChange: () => stages.push(coordinator.activityFor("private", targetId)?.stage || "idle")
    });
    const running = coordinator.tick();
    assert.equal(coordinator.activityFor("private", targetId)?.stage, "queued");
    assert.equal(coordinator.activityFor("group", targetId), null);
    releaseQueue();
    await running;
    assert.deepEqual(stages, ["queued", "checking", "reading", "reading", "reading", "idle"]);
    assert.equal(coordinator.activityFor("private", targetId), null);
  });
});

test("simultaneous QQ Space activity remains isolated by conversation", () => {
  const coordinator = new QzoneCoordinator();
  const group = { type: "group", id: "200000002" };
  const privateChat = { type: "private", id: "123456789" };
  coordinator.setScheduledActivity(group, "feed", "reading", { processed: 2, total: 5 });
  coordinator.setScheduledActivity(privateChat, "post", "posting");
  assert.equal(coordinator.activityFor("group", group.id)?.stage, "reading");
  assert.equal(coordinator.activityFor("private", privateChat.id)?.stage, "posting");
  coordinator.clearScheduledActivity(group);
  assert.equal(coordinator.activityFor("group", group.id), null);
  assert.equal(coordinator.activityFor("private", privateChat.id)?.stage, "posting");
});

test("OWNER manual feed reading shows only in that live conversation until it ends", async () => {
  await withStore(async (store) => {
    const feed = { uin: "123456789", key: "new", time: 1789990000, html: "新动态" };
    const coordinator = new QzoneCoordinator({ store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [feed], hasMore: false }) }
    });
    const message = { senderId: OWNER_QQ_ID, messageId: "m1", text: "老代看看动态" };
    const result = await coordinator.readManualFeeds({ targetType: "group", targetId: "200000002",
      messages: [message], trigger: { reason: "mention", trust: "OWNER", messageId: "m1" } });
    assert.equal(result.feeds.length, 1);
    assert.deepEqual({ ...coordinator.activityFor("group", "200000002"), startedAt: null },
      { kind: "feed", stage: "reading", manual: true, total: 1, startedAt: null });
    assert.equal(coordinator.activityFor("private", "200000002"), null);
    coordinator.clearManualActivity("group", "200000002");
    assert.equal(coordinator.activityFor("group", "200000002"), null);
  });
});

test("a same-hour post and feed check reserve one ordered sequence with separate prompts", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true, autoEngageEnabled: true });
    const now = new Date("2026-09-21T00:00:00Z");
    const feed = { uin: "123456789", key: "tid-new", time: Math.floor(now.getTime() / 1000) - 60, html: "新动态" };
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: (feed.time - 60) * 1000 } });
    const events = [];
    const worker = {
      async runQzoneSequence(_id, task) {
        events.push("reserved");
        await task(async (prompt, options) => {
          events.push(options.trigger);
          assert.equal(prompt.includes("【网关预读取结果】"), false);
          return { text: options.trigger === "qzone-post" ? "[[qq_zone_skip]]" : '{"actions":[]}' };
        });
        events.push("released");
      },
      async runQzoneTurn() { assert.fail("scheduled turns must use the reservation"); }
    };
    const coordinator = new QzoneCoordinator({ store, clock: () => now,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] }, groupWorker: worker,
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [feed], hasMore: false }) } });
    await coordinator.tick();
    assert.deepEqual(events, ["reserved", "qzone-post", "qzone-feed", "released"]);
  });
});

test("a new hourly job queues behind a still-running earlier hour", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true });
    let now = new Date("2026-09-21T00:00:00Z");
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const events = [];
    let previous = Promise.resolve();
    const worker = {
      runQzoneSequence(_id, task) {
        const order = events.filter((item) => item === "queued").length + 1;
        events.push("queued");
        const running = previous.then(async () => {
          if (order === 1) await firstGate;
          await task(async (prompt, options) => {
            events.push(`${options.trigger}:${prompt.match(/2026-09-21T\d\d:00/u)?.[0]}`);
            return { text: "[[qq_zone_skip]]" };
          });
        });
        previous = running;
        return running;
      }
    };
    const coordinator = new QzoneCoordinator({ store, clock: () => now,
      scheduleTimes: ["08:00", "09:00"],
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] }, groupWorker: worker });
    const first = coordinator.tick();
    await coordinator.tick();
    now = new Date("2026-09-21T01:00:00Z");
    const second = coordinator.tick();
    assert.deepEqual(events, ["queued", "queued"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["queued", "queued", "qzone-post:2026-09-21T08:00", "qzone-post:2026-09-21T09:00"]);
  });
});

test("when publishing and scanning share an hour, a missing feed decision retries without reposting", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true, autoEngageEnabled: true });
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const calls = [];
    const coordinator = new QzoneCoordinator({
      store, clock: () => new Date("2026-09-29T10:00:00Z"), scheduleTimes: ["18:00"],
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { codex: { supportsQqMcp: true, supportsSystemPrompt: true }, runQzoneTurn: async (_id, _prompt, options) => {
        calls.push(options.trigger);
        if (options.trigger === "qzone-post") {
          await options.qqToolContext.liveTool("skip_qzone_post");
        } else if (calls.filter((item) => item === "qzone-feed").length === 2) {
          const read = await options.qqToolContext.liveTool("read_qzone_feed_batch");
          const [feed] = JSON.parse(read.content[0].text);
          await options.qqToolContext.liveTool("submit_qzone_decisions", { actions: [{ type: "like", uin: feed.uin, tid: feed.tid }] });
        }
        return { text: "" };
      } },
      oneBot: {
        getQzoneFeedPage: async () => ({ feeds: [
          { uin: "123456789", key: "new", time: 1789950060, html: "新动态" },
          { uin: "123456789", key: "old", time: 1789950000, html: "旧动态" }
        ], hasMore: false }),
        likeQzone: async () => { calls.push("liked"); }
      }
    });
    await coordinator.tick();
    assert.deepEqual(calls, ["qzone-post", "qzone-feed", "qzone-feed", "liked"]);
    assert.equal(store.snapshot().actions["scan:2026-09-29T18:00"].status, "done");
    assert.equal(store.publicState().lastSeenFeedId, "123456789:new");
  });
});

test("a deleted feed does not retry its comment or block other posts and the scan cursor", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const calls = [];
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { runQzoneTurn: async () => ({ text: JSON.stringify({ actions: [
        { type: "like", uin: "123456789", tid: "gone" },
        { type: "comment", uin: "123456789", tid: "gone", content: "你好" },
        { type: "like", uin: "123456789", tid: "valid" }
      ] }) }) },
      oneBot: {
        getQzoneFeedPage: async () => ({ feeds: [
          { uin: "123456789", key: "valid", time: 1789950120, html: "另一条" },
          { uin: "123456789", key: "gone", time: 1789950060, html: "已删动态" },
          { uin: "123456789", key: "old", time: 1789950000, html: "旧动态" }
        ], hasMore: false }),
        likeQzone: async ({ tid }) => { calls.push(`like:${tid}`); if (tid === "gone") throw new Error("动态已删除"); },
        commentQzone: async ({ tid }) => { calls.push(`comment:${tid}`); }
      }
    });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-29T18:00");
    assert.deepEqual(calls, ["like:gone", "like:valid"]);
    assert.equal(store.snapshot().actions["scan:2026-09-29T18:00"].status, "done");
    assert.equal(store.publicState().lastSeenFeedId, "123456789:valid");
    assert.match(store.snapshot().actions["scan:2026-09-29T18:00"].message, /已删除或不可访问 1/);
  });
});

test("an hourly check with no new feeds never reserves a conversation or calls AI", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    const old = { uin: "123456789", key: "seen", time: 1789950000, html: "之前看过的动态" };
    await store.markFeeds(["123456789:seen"], { newestFeed: { id: "123456789:seen", timeMs: old.time * 1000 } });
    const events = [];
    const activities = [];
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: {
        runQzoneSequence: async () => assert.fail("no new feed must not reserve the conversation"),
        runQzoneTurn: async () => assert.fail("no new feed must not invoke AI")
      },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [old], hasMore: false }) },
      onEvent: (event) => events.push(event.type),
      onActivityChange: () => activities.push(coordinator.activityFor("group", "200000002")?.stage || "idle")
    });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-22T23:00");
    assert.deepEqual(events, ["qzone-scan-skipped"]);
    assert.deepEqual(activities, ["checking", "idle"]);
    assert.match(store.publicState().events[0].message, /没有待处理的新好友动态/);
    assert.equal(store.publicState().lastSeenFeedId, "123456789:seen");
  });
});

test("WorkBuddy scheduled posts use scoped MCP and cannot post twice", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoPostEnabled: true });
    const published = [];
    const coordinator = new QzoneCoordinator({
      store, groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { codex: { supportsQqMcp: true }, runQzoneTurn: async (_id, _prompt, options) => {
        const context = options.qqToolContext;
        assert.equal((await context.liveTool("propose_qzone_post", { content: "今天有点开心" })).isError, false);
        assert.deepEqual(published, []);
        assert.equal((await context.liveTool("propose_qzone_post", { content: "不要重复" })).isError, true);
        return { text: "ignored" };
      } },
      oneBot: { publishQzone: async (content) => { published.push(content); } }
    });
    await coordinator.runScheduledPost(coordinator.boundTarget(), "2026-09-22T08:00");
    assert.deepEqual(published, ["今天有点开心"]);
    assert.equal(store.snapshot().actions["post:2026-09-22T08:00"].status, "done");
  });
});

test("WorkBuddy hourly feed scan reads and acts through scoped MCP", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const sent = [];
    const coordinator = new QzoneCoordinator({
      store, groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { codex: { supportsQqMcp: true }, runQzoneTurn: async (_id, _prompt, options) => {
        const context = options.qqToolContext;
        assert.equal((await context.liveTool("submit_qzone_decisions", { actions: [] })).isError, true);
        const read = await context.liveTool("read_qzone_feed_batch");
        const feeds = JSON.parse(read.content[0].text);
        assert.deepEqual(feeds.map((feed) => feed.tid), ["new"]);
        assert.equal((await context.liveTool("submit_qzone_decisions", { actions: [{ type: "comment", uin: "999999999", tid: "new", content: "假目标" }] })).isError, true);
        assert.equal((await context.liveTool("submit_qzone_decisions", { actions: [
          { type: "like", uin: feeds[0].uin, tid: feeds[0].tid },
          { type: "comment", uin: feeds[0].uin, tid: feeds[0].tid, content: "很棒" }
        ] })).isError, false);
        assert.deepEqual(sent, []);
        return { text: "ignored" };
      } },
      oneBot: {
        getQzoneFeedPage: async () => ({ feeds: [
          { uin: "123456789", key: "new", time: 1789950060, html: "新动态" },
          { uin: "123456789", key: "old", time: 1789950000, html: "旧动态" }
        ], hasMore: false }),
        likeQzone: async (action) => { sent.push(["like", action.tid]); },
        commentQzone: async (action) => { sent.push(["comment", action.tid]); }
      }
    });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-22T09:00");
    assert.deepEqual(sent, [["like", "new"], ["comment", "new"]]);
    assert.equal(store.publicState().lastSeenFeedId, "123456789:new");
  });
});

test("scheduled scans traverse to the previous cursor, process every new feed oldest first, and allow each to be liked and commented", async () => {
  await withStore(async (store, filePath) => {
    const baseline = { uin: "123456789", key: "old", time: 1789950000, html: "旧动态" };
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: baseline.time * 1000 } });
    const pages = [
      Array.from({ length: 50 }, (_, i) => ({ ...baseline, key: `new${60 - i}`, time: baseline.time + (60 - i), html: `新动态 ${60 - i}` })),
      [...Array.from({ length: 10 }, (_, i) => ({ ...baseline, key: `new${10 - i}`, time: baseline.time + (10 - i), html: `新动态 ${10 - i}` })), baseline]
    ];
    const requestedPages = [];
    const seenBatches = [];
    const likes = [];
    const comments = [];
    let scanReservations = 0;
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { runQzoneSequence: async (_id, task) => {
        scanReservations += 1;
        return task(async (prompt) => {
        const current = [...prompt.matchAll(/123456789 \| (new\d+) \|/gu)].map((match) => match[1]);
        seenBatches.push(current);
        return { text: JSON.stringify({ actions: current.flatMap((tid) => [
          { type: "like", uin: "123456789", tid },
          { type: "comment", uin: "123456789", tid, content: `评论 ${tid}` },
          { type: "like", uin: "123456789", tid }
        ]) }) };
        });
      }, runQzoneTurn: async () => assert.fail("batches must use the scan reservation") },
      oneBot: {
        getQzoneFeedPage: async (pageNum, count) => { requestedPages.push([pageNum, count]); return { feeds: pages[pageNum - 1], hasMore: pageNum === 1 }; },
        likeQzone: async ({ tid }) => { likes.push(tid); },
        commentQzone: async ({ tid }) => { comments.push(tid); }
      }
    });
    const target = coordinator.boundTarget();
    await coordinator.runScheduledScan(target, "2026-09-21T09:00");
    assert.deepEqual(requestedPages, [[1, 50], [2, 50]]);
    assert.deepEqual(seenBatches.map((batch) => batch.length), [20, 20, 20]);
    assert.equal(scanReservations, 1, "all three feed batches share one reservation");
    assert.equal(seenBatches[0][0], "new1");
    assert.equal(seenBatches[2].at(-1), "new60");
    assert.equal(likes.length, 60);
    assert.equal(comments.length, 60);
    assert.equal(store.publicState().lastSeenFeedId, "123456789:new60");
    const reloaded = new QzoneStore({ filePath });
    await reloaded.init();
    assert.equal(reloaded.publicState().lastSeenFeedId, "123456789:new60");
    pages.splice(0, pages.length, [{ ...baseline, key: "new61", time: baseline.time + 61, html: "又一条" }, pages[0][0], baseline]);
    requestedPages.length = 0;
    await coordinator.runScheduledScan(target, "2026-09-21T10:00");
    assert.equal(scanReservations, 2);
    assert.deepEqual(requestedPages, [[1, 50]]);
    assert.deepEqual(seenBatches.at(-1), ["new61"]);
    assert.equal(likes.length, 61);
    assert.equal(comments.length, 61);
  });
});

test("an unreliable repeated feed page reports failure without advancing the cursor or taking partial actions", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const checkpoint = store.publicState().lastScanAt;
    const page = Array.from({ length: 50 }, (_, i) => ({ uin: "123456789", key: `new${i}`, time: 1789950100 + i, html: "新动态" }));
    let turns = 0;
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: { runQzoneTurn: async () => { turns += 1; return { text: '{"actions":[]}' }; } },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: page, hasMore: true }) }
    });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-21T09:00");
    assert.equal(turns, 0);
    assert.equal(store.publicState().lastSeenFeedId, "123456789:old");
    assert.equal(store.publicState().lastScanAt, checkpoint);
    assert.equal(store.hasFeed("123456789:new0"), false);
    assert.match(store.publicState().lastError, /翻页未前进/);
  });
});

test("feed cutoff uses the saved posting time even when the old feed id is absent", async () => {
  await withStore(async (store) => {
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const checkpoint = store.publicState().lastScanAt;
    const pages = [];
    const coordinator = new QzoneCoordinator({
      store,
      oneBot: { getQzoneFeedPage: async (pageNum) => {
        pages.push(pageNum);
        return { feeds: [
          { uin: "123456789", key: "new", time: 1789950100, html: "新动态" },
          { uin: "123456789", key: "same-second", time: 1789950000, html: "同秒新动态" },
          { uin: "123456789", key: "older", time: 1789949999, html: "更早动态" }
        ], hasMore: true };
      } }
    });
    const result = await coordinator.readUnseenFeeds();
    assert.deepEqual(pages, [1]);
    assert.deepEqual(result.fresh.map((feed) => feed.tid), ["new", "same-second"]);
    assert.equal(result.coverageGap, false);
    assert.equal(store.publicState().lastSeenFeedId, "123456789:old");
    assert.equal(store.publicState().lastScanAt, checkpoint);
  });
});

test("a truncated visible feed window is processed with an explicit time coverage warning", async () => {
  await withStore(async (store) => {
    await store.markFeeds(["123456789:old"], { newestFeed: { id: "123456789:old", timeMs: 1789950000000 } });
    const coordinator = new QzoneCoordinator({
      store,
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [
        { uin: "123456789", key: "newer", time: 1789950100, html: "新动态" },
        { uin: "123456789", key: "new", time: 1789950060, html: "另一条" }
      ], hasMore: false }) }
    });
    const result = await coordinator.readUnseenFeeds();
    assert.deepEqual(result.fresh.map((feed) => feed.tid), ["newer", "new"]);
    assert.equal(result.coverageGap, true);
    await store.markFeeds(result.observedIds, { newestFeed: result.newestFeed });
    assert.equal(store.publicState().lastSeenFeedTimeMs, 1789950100000);
    await store.markFeeds([], { newestFeed: { id: "123456789:older", timeMs: 1789949999000 } });
    assert.equal(store.publicState().lastSeenFeedTimeMs, 1789950100000);
  });
});

test("SnowLuma QQ Space API payloads use documented endpoints", async () => {
  const calls = [];
  const client = new OneBotClient({ baseUrl: "http://localhost:3000", fetchImpl: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ status: "ok", retcode: 0, data: { feeds: [] } }) };
  } });
  await client.getQzoneFeeds(12);
  await client.getQzoneFeedPage(2, 50);
  await client.publishQzone("一句话", { visibility: 4 });
  await client.publishQzone("另一句", { visibility: 64 });
  await client.likeQzone({ uin: "123456789", tid: "tid123456", abstime: 123 });
  await client.commentQzone({ uin: "123456789", tid: "tid123456", content: "好看" });
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/get_qzone_feeds", "/get_qzone_feeds", "/send_qzone_msg", "/send_qzone_msg", "/like_qzone", "/comment_qzone"]);
  assert.deepEqual(calls[1].body, { page_num: 2, count: 50 });
  assert.equal(calls[2].body.ugc_right, 1);
  assert.equal(calls[3].body.ugc_right, 1);
  assert.equal(calls[4].body.abstime, 123);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { QzoneCoordinator, normalizeFeeds, parseEngagementDecisions, parseQzonePostDirectives } from "../src/qq/qzone-coordinator.js";
import { QzoneStore } from "../src/qq/qzone-store.js";
import { OWNER_QQ_ID } from "../src/security/policy.js";

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
      "老代去强尼手银的动态里锐评一下",
      "老代看看强尼手银的动态"
    ]) {
      assert.equal(coordinator.shouldWakeForOwnerRequest(owner(text), "group", "200000001"), false, text);
    }
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

test("an hourly check with no new feeds never reserves a conversation or calls AI", async () => {
  await withStore(async (store) => {
    await store.configure({ targetType: "group", targetId: "200000002", autoEngageEnabled: true });
    const old = { uin: "123456789", key: "seen", time: 1789950000, html: "之前看过的动态" };
    await store.markFeeds(["123456789:seen"], { newestFeed: { id: "123456789:seen", timeMs: old.time * 1000 } });
    const events = [];
    const coordinator = new QzoneCoordinator({
      store,
      groupStore: { listGroups: () => [{ groupId: "200000002", replyEnabled: true }] },
      privateStore: { listGroups: () => [] },
      groupWorker: {
        runQzoneSequence: async () => assert.fail("no new feed must not reserve the conversation"),
        runQzoneTurn: async () => assert.fail("no new feed must not invoke AI")
      },
      oneBot: { getQzoneFeedPage: async () => ({ feeds: [old], hasMore: false }) },
      onEvent: (event) => events.push(event.type)
    });
    await coordinator.runScheduledScan(coordinator.boundTarget(), "2026-09-22T23:00");
    assert.deepEqual(events, ["qzone-scan-skipped"]);
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

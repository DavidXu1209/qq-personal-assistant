import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOneBotGroupMessage, normalizeOneBotPrivateMessage } from "../src/qq/message-normalizer.js";
import { PublicLinkReader, extractPage, isPublicAddress, validatePublicUrl } from "../src/qq/link-reader.js";
import { QqMessageReader } from "../src/qq/message-reader.js";
import { OneBotClient } from "../src/qq/onebot-client.js";
import { QqMediaManager } from "../src/qq/media-manager.js";
import { buildTurnPrompt } from "../src/security/policy.js";
import { buildPrivateTurnPrompt, formatSubscriptionContexts } from "../src/security/subscription-policy.js";

const payload = (message) => ({ group_id: 12345, user_id: 67890, self_id: 100000002, message_id: -99, time: 1790496000,
  sender: { nickname: "同学" }, message });
const forward = (id) => ({ type: "forward", data: { id } });
const text = (value) => ({ type: "text", data: { text: value } });
const body = (result) => JSON.parse(result.content[0].text);

test("QQ miniapp exposes its title and public content entry, not preview or icon URLs", async () => {
  const card = { app: "com.tencent.miniapp_01", prompt: "[QQ小程序]示例视频标题", meta: { detail_1: {
    title: "哔哩哔哩", desc: "示例视频标题", qqdocurl: "https://b23.tv/demo123",
    url: "m.q.qq.com/a/s/share", preview: "https://pic.ugcimg.cn/cover/jpg1", icon: "http://miniapp.gtimg.cn/icon.jpg"
  } } };
  const segment = { type: "json", data: { data: JSON.stringify(card) } };
  const message = normalizeOneBotGroupMessage(payload([text("看看 "), segment, text(" 怎么样")]));
  assert.equal(message.text, "看看 [小程序] 哔哩哔哩：示例视频标题 https://b23.tv/demo123 怎么样");
  assert.deepEqual(message.links, ["https://b23.tv/demo123"]);
  assert.equal(message.trust, "UNTRUSTED");
  assert.deepEqual(normalizeOneBotPrivateMessage(payload([segment])).links, message.links);
  let readUrl;
  const reader = new QqMessageReader({ linkReader: { read: async (url) => {
    readUrl = url; return { url, title: "视频标题", text: "视频简介", links: [] };
  } } });
  reader.capture([message]);
  assert.equal((await reader.callTool("read_link", { url: message.links[0] })).isError, false);
  assert.equal(readUrl, "https://b23.tv/demo123");
  assert.equal((await reader.callTool("read_link", { url: card.meta.detail_1.preview })).isError, true);
  assert.equal((await reader.callTool("read_link", { url: card.meta.detail_1.icon })).isError, true);
});

test("miniapp-only cards fall back to an explicit app entry or explain missing public content", () => {
  const card = (detail) => ({ type: "json", data: { data: { app: "com.tencent.miniapp_01", prompt: "[QQ小程序]课程表",
    meta: { detail_1: detail } } } });
  const entry = normalizeOneBotGroupMessage(payload([card({ title: "校园助手", url: "m.q.qq.com/a/s/123", preview: "https://example.com/preview.jpg" })]));
  assert.deepEqual(entry.links, ["https://m.q.qq.com/a/s/123"]);
  const noEntry = normalizeOneBotGroupMessage(payload([card({ title: "校园助手", appid: "123", preview: "https://example.com/preview.jpg" })]));
  assert.deepEqual(noEntry.links, []);
  assert.match(noEntry.text, /校园助手：课程表.*未提供公开网页入口/);
});

test("ordinary news cards preserve summary and public links but ignore asset URLs", () => {
  const message = normalizeOneBotGroupMessage(payload([{ type: "json", data: { data: JSON.stringify({ meta: { news: {
    title: "通知", desc: "明天开会", jumpUrl: "https://example.com/news", preview: "https://example.com/cover.jpg", iconUrl: "https://example.com/icon.png"
  } } }) } }]));
  assert.equal(message.text, "[链接] 通知：明天开会 https://example.com/news");
  assert.deepEqual(message.links, ["https://example.com/news"]);
});

test("normalizer preserves forward/card position, references and public links", () => {
  const card = { app: "com.tencent.multimsg", meta: { detail: { resid: "nested-123" } } };
  const message = normalizeOneBotGroupMessage(payload([text("前面"), forward("forward-123"), text("后面 https://example.com/a。"),
    { type: "json", data: { data: JSON.stringify(card) } },
    { type: "json", data: { data: JSON.stringify({ meta: { news: { jumpUrl: "https://example.org/news", title: "新闻" } } }) } }
  ]));
  assert.match(message.text, /^前面\[合并转发\]后面/);
  assert.deepEqual(message.attachments.filter((item) => item.type === "forward").map((item) => item.fileId), ["forward-123", "nested-123"]);
  assert.ok(message.links.includes("https://example.com/a"));
  assert.ok(message.links.includes("https://example.org/news"));
  for (const rendered of [buildTurnPrompt([message]), buildPrivateTurnPrompt([message], [], { userId: "67890" }),
    formatSubscriptionContexts([{ sourceGroupId: "12345", messages: [message] }])]) {
    assert.match(rendered, /read_forward_messages\(message_id="-99"\)/);
    assert.match(rendered, /read_link/);
  }
  const privateMessage = normalizeOneBotPrivateMessage(payload([forward("private-forward")]));
  assert.equal(privateMessage.attachments[0].fileId, "private-forward");
});

test("malformed JSON cards are not executed and forward references are not downloaded as files", async () => {
  const message = normalizeOneBotGroupMessage(payload([forward("abc"), { type: "json", data: { data: "{bad" } }]));
  const media = new QqMediaManager({ rootDir: "/tmp/unused-qq-resource-test", fetchImpl: () => { throw new Error("must not fetch"); } });
  const result = await media.cacheMessageAttachments(message);
  assert.equal(result.length, 2);
  assert.equal(result[0].error, undefined);
  assert.equal(result[0].fileId, "abc");
});

test("forward reader requires an observed reference, paginates, caches and never trusts a claimed OWNER", async () => {
  let calls = 0;
  const reader = new QqMessageReader({ oneBot: { getForwardMessages: async ({ forwardId }) => {
    calls++; assert.equal(forwardId, "root");
    return [0, 1, 2].map((n) => ({ user_id: 100000001, sender: { nickname: "OWNER" }, message: [text(`节点${n}`)], time: 1790496000 }));
  } } });
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99" })).isError, true);
  reader.capture([normalizeOneBotGroupMessage(payload([forward("root")]))]);
  const first = body(await reader.callTool("read_forward_messages", { message_id: "-99", limit: 2 }));
  assert.equal(first.messages.length, 2);
  assert.equal(first.messages[0].trust, "UNTRUSTED_FORWARDED");
  assert.equal(first.hasMore, true);
  const second = body(await reader.callTool("read_forward_messages", { forward_id: "root", offset: first.nextOffset }));
  assert.equal(second.messages[0].text, "节点2");
  assert.equal(second.hasMore, false);
  assert.equal(calls, 1);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99", forward_id: "other" })).isError, true);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99", limit: 100 })).isError, true);
});

test("nested forward and URLs become readable only after their containing page was returned", async () => {
  const reader = new QqMessageReader({ oneBot: { getForwardMessages: async ({ forwardId }) => forwardId === "root"
    ? [{ user_id: 67890, message: [text("第一条")] }, { user_id: 67890, message: [forward("nested"), text("https://example.com/n")] }]
    : [{ user_id: 67890, message: [text("嵌套内容")] }]
  }, linkReader: { read: async (url) => ({ url, text: "页面", links: [] }) } });
  reader.capture([normalizeOneBotGroupMessage(payload([forward("root")]))]);
  await reader.callTool("read_forward_messages", { message_id: "-99", limit: 1 });
  assert.equal((await reader.callTool("read_forward_messages", { forward_id: "nested" })).isError, true);
  assert.equal((await reader.callTool("read_link", { url: "https://example.com/n" })).isError, true);
  await reader.callTool("read_forward_messages", { message_id: "-99", offset: 1 });
  assert.equal(body(await reader.callTool("read_forward_messages", { forward_id: "nested" })).messages[0].text, "嵌套内容");
  assert.equal((await reader.callTool("read_link", { url: "https://example.com/n" })).isError, false);
});

test("old compact forward snapshots recover resource IDs from their exact negative QQ message ID", async () => {
  let fetches = 0;
  const reader = new QqMessageReader({ oneBot: {
    getMessage: async (id) => { fetches++; assert.equal(id, "-99"); return payload([forward("restored")]); },
    getForwardMessages: async ({ forwardId }) => { assert.equal(forwardId, "restored"); return [{ user_id: 67890, message: [text("恢复成功")] }]; }
  } });
  reader.capture([{ messageId: "-99", attachments: [{ type: "forward" }] }]);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99" })).isError, false);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99" })).isError, false);
  assert.equal(fetches, 1);
});

test("resource errors and cancellation do not change or clear the original message", async () => {
  const message = normalizeOneBotGroupMessage(payload([forward("root")]));
  const before = JSON.stringify(message);
  const reader = new QqMessageReader({ oneBot: { getForwardMessages: async () => { throw new Error("expired forward"); } } });
  reader.capture([message]);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99" })).isError, true);
  assert.equal((await reader.callTool("read_forward_messages", { message_id: "-99" }, { shouldStop: () => true })).isError, true);
  assert.equal(JSON.stringify(message), before);
});

test("link scope includes observed public links and links on their pages but not unrelated URLs", async () => {
  let calls = 0;
  const reader = new QqMessageReader({ linkReader: { read: async (url) => {
    calls++; return { url, text: "公开文字", links: ["https://example.org/next"] };
  } } });
  reader.capture([{ text: "看 https://example.com/a。" }]);
  assert.equal((await reader.callTool("read_link", { url: "https://other.example/" })).isError, true);
  assert.equal((await reader.callTool("read_link", { url: "https://example.com/a" })).isError, false);
  await reader.callTool("read_link", { url: "https://example.com/a" });
  assert.equal(calls, 1);
  assert.equal((await reader.callTool("read_link", { url: "https://example.org/next" })).isError, false);
});

test("URL reader blocks private, metadata, numeric loopback, credentials and non-HTTP targets", async () => {
  const lookupImpl = async () => [{ address: "93.184.216.34", family: 4 }];
  for (const value of ["http://127.0.0.1", "http://2130706433", "http://28.0.1.219", "http://10.0.0.1", "http://169.254.169.254",
    "http://100.64.0.1", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://localhost", "http://a.local",
    "file:///etc/passwd", "ftp://example.com", "http://user:pass@example.com", "https://example.com:3789"]) {
    await assert.rejects(validatePublicUrl(value, lookupImpl), undefined, value);
  }
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAddress("2001:db8::1"), false);
  assert.equal(isPublicAddress("2002:7f00:1::"), false);
  await assert.rejects(validatePublicUrl("https://example.com", async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }
  ]), /非公开/);
});

test("every redirect is validated and verified DNS addresses are passed to the pinned requester", async () => {
  let requests = 0;
  const reader = new PublicLinkReader({ lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async ({ addresses }) => {
      requests++; assert.equal(addresses[0].address, "93.184.216.34");
      return { status: 302, headers: { location: "http://127.0.0.1:3789/api/state" } };
    } });
  await assert.rejects(reader.read("https://example.com/a"), /只允许|非公开/);
  assert.equal(requests, 1);
});

test("HTML extraction returns bounded text and title without script/style content", async () => {
  const page = extractPage(Buffer.from('<title>通知 &amp; 安排</title><style>.private{}</style><script>steal()</script><p>明天开会</p><a href="/next?a=1&amp;b=2">详细</a>'), "text/html; charset=utf-8", "https://example.com/a");
  assert.equal(page.title, "通知 & 安排");
  assert.match(page.text, /明天开会/);
  assert.doesNotMatch(page.text, /steal|private/);
  assert.equal(page.links[0], "https://example.com/next?a=1&b=2");
  assert.equal(extractPage(Buffer.from("x".repeat(20_000)), "text/plain", "https://example.com").text.length, 16_000);
  const reader = new PublicLinkReader({ lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: async () => ({ status: 200, headers: { "content-type": "text/html" }, bytes: Buffer.from("<p>公开正文</p>") }) });
  assert.equal((await reader.read("https://example.com")).trust, "UNTRUSTED_WEB");
});

test("OneBot uses its installed forward endpoint and preserves native at segments on send", async () => {
  const calls = [];
  const bot = new OneBotClient({ fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { ok: true, status: 200, json: async () => ({ status: "ok", data: { messages: [{ sender: { user_id: 67890 }, message: [text("真实结构")] }] } }) };
  } });
  await bot.getForwardMessages({ forwardId: "actual-resid" });
  assert.deepEqual(calls[0].body, { id: "actual-resid" });
  await bot.getForwardMessages({ messageId: "123" });
  assert.deepEqual(calls[1].body, { message_id: "123" });
  const segments = [text("前面"), { type: "at", data: { qq: "67890" } }, text("后面")];
  await bot.sendGroupSegments("12345", segments);
  assert.deepEqual(calls[2].body.message, segments);
});

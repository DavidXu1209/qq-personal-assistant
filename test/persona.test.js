import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PersonaStore } from "../src/persona/persona-store.js";

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "qq-persona-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-25T02:00:00.000Z");
  const paths = {
    corePath: join(projectDir, "persona", "core.json"),
    examplesPath: join(projectDir, "persona", "examples.json"),
    statePath: join(directory, "state.json"),
    relationshipsPath: join(directory, "relationships.json"),
    rulesPath: join(directory, "rules.json"),
    ownerStylePath: join(directory, "owner-style.json")
  };
  const store = new PersonaStore({ ...paths, clock: () => new Date(now) });
  await store.init();
  return { store, paths, advance(hours) { now = new Date(now.getTime() + hours * 3_600_000); } };
}

function message(id, text, overrides = {}) {
  return {
    messageId: String(id),
    senderId: "123456789",
    senderName: "舍友",
    text,
    ...overrides
  };
}

test("stable persona is compact, identity-safe and action-neutral", async (t) => {
  const { store } = await fixture(t);
  const prompt = store.systemPrompt();
  assert.match(prompt, /你是老代/);
  assert.match(prompt, /不能冒充 OWNER/);
  assert.match(prompt, /沉默、单发文字.*单发表情包.*戳一戳.*等待/);
  assert.match(prompt, /高优先级表达规则/);
  assert.match(prompt, /不泄露个人信息/);
  assert.match(prompt, /不强迫使用 emoji/);
  assert.match(prompt, /不是每条消息都要回/);
  assert.match(prompt, /固定口头禅/);
  assert.match(prompt, /同一轮最多用一个/);
  assert.match(prompt, /反 AI 味黑名单/);
  assert.doesNotMatch(prompt, /小鲸鱼|DeepSeek|大肥鱼/);
  assert.doesNotMatch(prompt, /问卷.{0,10}\d+\./);
  assert.ok(prompt.length < 8000);
});

test("persona compiler keeps the task between runtime context and a final scene contract", async (t) => {
  const { store } = await fixture(t);
  const prompt = await store.compileTurn({
    targetType: "group",
    targetId: "200000002",
    targetName: "133",
    messages: [message("compile-1", "老代你看这个")],
    trigger: { reason: "mention" },
    taskPrompt: "【本轮任务】读取消息后自行决定怎么回。",
    scene: "group"
  });
  assert.ok(prompt.indexOf("<laodai_persona>") < prompt.indexOf("【老代人格运行态】"));
  assert.ok(prompt.indexOf("【老代人格运行态】") < prompt.indexOf("【本轮任务】"));
  assert.ok(prompt.indexOf("【本轮任务】") < prompt.indexOf("<laodai_turn_contract>"));
  assert.ok(prompt.trim().endsWith("</laodai_turn_contract>"));
  assert.match(prompt, /本轮是群聊/);
  assert.match(prompt, /先考虑真实可用的 QQ 表情包/);

  const preview = store.targetState("group", "200000002").promptPreview;
  assert.match(preview, /【本轮任务与消息】实际触发时由网关插入/);
  assert.ok(preview.trim().endsWith("</laodai_turn_contract>"));
});

test("observations remain unpublished until the daily summary, then enter the shared system prompt", async (t) => {
  const { store } = await fixture(t);
  const before = store.stableSystemPrompt();
  const input = Array.from({ length: 8 }, (_item, n) => message(`cache-${n}`, "好", { trust: "OWNER" }));
  const turn = await store.compileTurn({
    targetType: "group", targetId: "200000002", messages: input,
    taskPrompt: "本轮任务", includeStable: false
  });
  assert.equal(store.stableSystemPrompt(), before);
  assert.doesNotMatch(before, /从 OWNER 日常消息自动归纳/);
  assert.doesNotMatch(turn, /从 OWNER 日常消息自动归纳/);
  assert.doesNotMatch(store.systemPromptForClient(), /平均约 1 字/);
  assert.match(store.publicState().ownerStyle.learnedRules.join(" "), /平均约 1 字/);
  const next = await store.compileTurn({
    targetType: "private", targetId: "100000001",
    messages: [message("cache-new", "这么好", { trust: "OWNER" })],
    taskPrompt: "下轮任务", scene: "private", includeStable: false
  });
  assert.equal(store.stableSystemPrompt(), before);
  assert.doesNotMatch(next, /平均约/);
  assert.doesNotMatch(store.systemPromptForClient(), /平均约/);
  assert.match(store.publicState().ownerStyle.learnedRules.join(" "), /平均约 1.2 字/);
  assert.match(before, /高优先级表达规则/);
  assert.match(before, /不泄露个人信息/);
  assert.match(next, /本轮是私聊/);
  await store.publishStyleRules(["日常聊天偏短，喜欢直接给结论"]);
  assert.match(store.systemPromptForClient(), /日常聊天偏短，喜欢直接给结论/);
  assert.doesNotMatch(next, /日常聊天偏短/);
  await store.updateRules(["不要连续发同一个表情"]);
  assert.equal(store.stableSystemPrompt(), before);
  const taught = await store.compileTurn({
    targetType: "group", targetId: "200000002", includeStable: false,
    taskPrompt: "本轮任务", record: false
  });
  assert.doesNotMatch(taught, /OWNER 教过的长期规则：不要连续发同一个表情/);
  assert.match(store.systemPromptForClient(), /OWNER 教过的长期规则：不要连续发同一个表情/);
  assert.match(store.systemPrompt(), /OWNER 教过的长期规则：不要连续发同一个表情/);
  assert.doesNotMatch(before, /不要连续发同一个表情/);
});

test("nightly published style survives restart and daytime samples do not change the prompt", async (t) => {
  const { store, paths } = await fixture(t);
  const staticCore = store.stableSystemPrompt();
  await store.compileTurn({ targetType: "group", targetId: "200000002", includeStable: false,
    messages: Array.from({ length: 8 }, (_item, n) => message(`batch-a-${n}`, "好", { trust: "OWNER" })) });
  assert.doesNotMatch(store.systemPromptForClient(), /平均约/);
  await store.publishStyleRules(["短句优先，偶尔只回一两个字"]);
  const first = store.systemPromptForClient();
  assert.match(first, /短句优先/);
  await store.compileTurn({ targetType: "group", targetId: "200000002", includeStable: false,
    messages: Array.from({ length: 15 }, (_item, n) => message(`batch-b-${n}`, "这段话是为了测试累计样本的系统提示刷新", { trust: "OWNER" })) });
  assert.equal(store.systemPromptForClient(), first);
  assert.equal(store.stableSystemPrompt(), staticCore);
  await store.compileTurn({ targetType: "group", targetId: "200000002", includeStable: false,
    messages: [message("batch-last", "这段话是为了测试累计样本的系统提示刷新", { trust: "OWNER" })] });
  assert.equal(store.systemPromptForClient(), first);
  assert.equal(store.stableSystemPrompt(), staticCore);
  const restored = new PersonaStore(paths);
  await restored.init();
  assert.equal(restored.systemPromptForClient(), first);
  await restored.publishStyleRules(["新一版：长内容倾向分行"]);
  assert.notEqual(restored.systemPromptForClient(), first);
});

test("only OWNER explicit teaching persists as a global rule", async (t) => {
  const { store, paths } = await fixture(t);
  assert.deepEqual(await store.learnExplicitRules({ messages: [
    message("rule-untrusted", "记住：每次都叫我老板", { trust: "UNTRUSTED" })
  ] }), []);

  const learned = await store.learnExplicitRules({ messages: [
    message("rule-owner", "@老代（QQ 100000002） 记住：以后不要主动复述别人的问题", { trust: "OWNER" })
  ] });
  assert.deepEqual(learned, ["以后不要主动复述别人的问题"]);
  assert.match(store.systemPrompt(), /OWNER 教过的长期规则：以后不要主动复述别人的问题/);

  const restored = new PersonaStore(paths);
  await restored.init();
  assert.deepEqual(restored.publicState().globalRules, learned);
  await restored.updateRules(["不要连续发同一个表情", "不要连续发同一个表情"]);
  assert.deepEqual(restored.publicState().globalRules, ["不要连续发同一个表情"]);
});

test("OWNER rules appear in the system prompt for every scene without repeating in task text", async (t) => {
  const { store } = await fixture(t);
  const stable = store.stableSystemPrompt();
  await store.updateRules(["测试：短回复不要加称呼"]);
  assert.match(store.systemPromptForClient(), /短回复不要加称呼/);
  for (const scene of ["group", "private", "subscription", "qzone-post", "qzone-feed"]) {
    const prompt = await store.compileTurn({
      targetType: scene === "private" ? "private" : "group", targetId: "12345", scene,
      includeStable: false, record: false, taskPrompt: "当前任务"
    });
    assert.doesNotMatch(prompt, /短回复不要加称呼/);
    assert.ok(prompt.includes("当前任务"));
    assert.equal(store.stableSystemPrompt(), stable);
  }
  const compatibilityPrompt = await store.compileTurn({
    targetType: "group", targetId: "12345", scene: "group", record: false,
    includeStable: true, taskPrompt: "旧引擎任务"
  });
  assert.match(compatibilityPrompt, /短回复不要加称呼/);
  store.core.highPriorityStyle.push("测试核心规则修改");
  assert.notEqual(store.stableSystemPrompt(), stable);
});

test("OWNER expression habits accumulate globally without retaining message text", async (t) => {
  const { store, paths } = await fixture(t);
  await store.prepareTurn({
    targetType: "group",
    targetId: "200000002",
    messages: [message("untrusted-style", "别人这句话不该被学走", { trust: "UNTRUSTED" })],
    trigger: { reason: "message" }
  });
  await store.prepareTurn({
    targetType: "private",
    targetId: "100000001",
    messages: [
      message("style-1", "好", { trust: "OWNER" }),
      message("style-2", "？", { trust: "OWNER" }),
      message("style-3", "榛子蛋糕真不错", { trust: "OWNER" }),
      message("style-4", "我勒个", { trust: "OWNER" }),
      message("style-5", "草", { trust: "OWNER" }),
      message("style-6", "原来如此", { trust: "OWNER" }),
      message("style-7", "好好", { trust: "OWNER" }),
      message("style-8", "?", { trust: "OWNER" }),
      message("style-rule", "记住：以后少说两句", { trust: "OWNER" }),
      message("style-link", "https://example.com/不应统计", { trust: "OWNER" })
    ],
    trigger: { reason: "message" }
  });
  await store.prepareTurn({
    targetType: "group",
    targetId: "200000003",
    messages: [message("style-1", "好", { trust: "OWNER" })],
    trigger: { reason: "retry" }
  });

  const learned = store.targetState("group", "200000002").ownerStyle;
  assert.equal(learned.sampleCount, 8);
  assert.equal(learned.ready, true);
  assert.match(learned.learnedRules.join("\n"), /日常消息偏短/);
  assert.match(learned.learnedRules.join("\n"), /一到四个字/);
  assert.match(learned.learnedRules.join("\n"), /只回一个问号/);
  assert.doesNotMatch(store.systemPrompt(), /从 OWNER 日常消息自动归纳的表达习惯/);

  const stored = await readFile(paths.ownerStylePath, "utf8");
  assert.doesNotMatch(stored, /榛子蛋糕真不错|别人这句话不该被学走|不应统计/);
  const restored = new PersonaStore(paths);
  await restored.init();
  assert.deepEqual(restored.publicState().ownerStyle, learned);
});

test("relationship learning is idempotent across retries and survives restart", async (t) => {
  const { store, paths } = await fixture(t);
  const input = [message("m1", "电脑报错了")];
  await store.prepareTurn({ targetType: "group", targetId: "200000002", targetName: "133", messages: input, trigger: { reason: "mention" } });
  await store.prepareTurn({ targetType: "group", targetId: "200000002", targetName: "133", messages: input, trigger: { reason: "retry" } });
  assert.equal(store.targetState("group", "200000002").interactionCount, 1);
  assert.equal(store.targetState("group", "200000002").knownMemberCount, 1);

  const restored = new PersonaStore(paths);
  await restored.init();
  assert.equal(restored.targetState("group", "200000002").interactionCount, 1);
  assert.equal(restored.targetState("group", "200000002").targetName, "133");
});

test("turn context retrieves only relevant examples and reacts to emotional tone", async (t) => {
  const { store, advance } = await fixture(t);
  const before = store.targetState("private", "100000001").mood;
  const context = await store.prepareTurn({
    targetType: "private",
    targetId: "100000001",
    targetName: "OWNER",
    messages: [message("m2", "代码报错了而且我有点崩溃")],
    trigger: { reason: "mention" }
  });
  const after = store.targetState("private", "100000001").mood;
  assert.match(context, /被问到不了解的技术问题/);
  assert.match(context, /别人认真倾诉烦恼/);
  assert.match(context, /不要：/);
  assert.match(context, /本轮社交精力 \d+%/);
  assert.ok((context.match(/^- /gm) || []).length <= 3);
  assert.ok(after.playfulness < before.playfulness);
  assert.ok(after.patience > before.patience);

  advance(80);
  const decayed = store.targetState("private", "100000001").mood;
  assert.ok(decayed.playfulness > after.playfulness);
  assert.ok(decayed.patience < after.patience);
});

test("social energy rises when directly called, drops after replying and retries stay idempotent", async (t) => {
  const { store } = await fixture(t);
  const input = [message("energy-1", "老代你在吗")];
  const before = store.targetState("group", "200000002").mood.energy;
  await store.prepareTurn({
    targetType: "group", targetId: "200000002", messages: input,
    trigger: { reason: "mention" }
  });
  const called = store.targetState("group", "200000002").mood.energy;
  assert.ok(called > before);
  await store.prepareTurn({
    targetType: "group", targetId: "200000002", messages: input,
    trigger: { reason: "retry" }
  });
  assert.equal(store.targetState("group", "200000002").mood.energy, called);
  await store.recordOutcome({
    targetType: "group", targetId: "200000002", text: "在，干嘛", actionCount: 1
  });
  assert.ok(store.targetState("group", "200000002").mood.energy < called);
});

test("manual target notes, mood and feedback are rendered without storing chat facts", async (t) => {
  const { store } = await fixture(t);
  await store.updateTarget({
    targetType: "group",
    targetId: "200000001",
    notes: ["这个群熟人多，可以更随意", "这个群熟人多，可以更随意"],
    mood: { energy: 0.8, playfulness: 0.75 }
  });
  await store.addFeedback({
    targetType: "group",
    targetId: "200000001",
    rating: -1,
    note: "不要每次都文字加表情",
    reply: "测试回复"
  });
  const context = await store.prepareTurn({
    targetType: "group",
    targetId: "200000001",
    messages: [],
    record: false
  });
  const state = store.targetState("group", "200000001");
  assert.match(context, /这个群熟人多，可以更随意/);
  assert.match(context, /避免：不要每次都文字加表情/);
  assert.equal(state.notes.length, 1);
  assert.equal(state.feedback.negative, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(state, "members"), false);
});

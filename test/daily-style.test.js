import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTaskGate } from "../src/qq/agent-task-gate.js";
import { DailyStyleCoordinator, latestStyleCutoff, parseStyleSummary, plainOwnerText } from "../src/persona/daily-style-coordinator.js";

function ownerMessage(id, groupId = "200000002") {
  return { messageId: String(id), groupId, rawType: "group", trust: "OWNER" };
}

function plainPayload(text) { return { message_type: "group", message: [{ type: "text", data: { text } }] }; }

test("04:00 Shanghai cutoff and pure OWNER text extraction", () => {
  assert.equal(latestStyleCutoff(new Date("2026-09-27T19:59:59Z")), "2026-09-26T20:00:00.000Z");
  assert.equal(latestStyleCutoff(new Date("2026-09-27T20:00:00Z")), "2026-09-27T20:00:00.000Z");
  assert.equal(plainOwnerText(plainPayload("这么好"), ownerMessage(1)), "这么好");
  assert.equal(plainOwnerText(plainPayload("不收"), { ...ownerMessage(2), trust: "UNTRUSTED" }), "");
  assert.equal(plainOwnerText({ message: [{ type: "text", data: { text: "图" } }, { type: "image", data: {} }] }, ownerMessage(3)), "");
  assert.throws(() => parseStyleSummary('{"styleRules":["QQ 123456789 说话快"]}'), /敏感内容/);
  assert.throws(() => parseStyleSummary(JSON.stringify({ styleRules: Array(6).fill("短句") })), /数量无效/);
  assert.throws(() => parseStyleSummary(JSON.stringify({ styleRules: ["短".repeat(56)] })), /敏感内容/);
  assert.throws(() => parseStyleSummary(JSON.stringify({ styleRules: Array(5).fill("短".repeat(50)) })), /敏感内容/);
});

test("daily summary waits for active replies, publishes once, cleans ephemeral thread and raw samples", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-daily-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T19:50:00Z");
  const calls = [];
  let published = ["上一版：说话比较直接"];
  let sharedModel = "hy3";
  const codex = {
    model: "test-model",
    async startThread(options) { calls.push(["start", options]); return options.threadId; },
    async runTurn(options) { calls.push(["turn", options]); return { text: '{"styleRules":["短句直接，不爱用逗号"]}' }; },
    async deleteThread(id, options) { calls.push(["delete", id, options]); }
  };
  const gate = new AgentTaskGate();
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona: { getPublishedStyleRules: () => [...published], async publishDailyUpdate({ rules }) { published = rules; } },
    codex, gate, getModel: () => sharedModel, clock: () => now });
  await daily.init();
  assert.equal(await daily.capture(plainPayload("这么好"), ownerMessage(1)), true);
  assert.equal(await daily.capture(plainPayload("这么好"), ownerMessage(1)), false);
  assert.equal(daily.snapshot().pendingSamples, 1);
  await daily.tick();
  assert.equal(calls.length, 0);
  const release = gate.tryEnter();
  now = new Date("2026-09-27T20:01:00Z");
  sharedModel = "deepseek-v4.1-flash";
  assert.equal(daily.snapshot().model, sharedModel);
  const running = daily.tick();
  assert.equal(gate.blocked, true);
  assert.equal(calls.length, 0);
  release();
  await running;
  assert.deepEqual(published, ["短句直接，不爱用逗号"]);
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "turn", "delete"]);
  assert.equal(calls[0][1].model, sharedModel);
  assert.equal(calls[1][1].model, sharedModel);
  assert.equal(calls[0][1].ephemeral, true);
  assert.equal(calls[1][1].workingMode, "agent");
  assert.equal(calls[1][1].prefetchQqMessages, false);
  assert.match(calls[1][1].prompt, /上一版：说话比较直接/);
  assert.match(calls[1][1].prompt, /完整替换版，不追加旧规则/);
  assert.equal(daily.snapshot().pendingSamples, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "samples.json"), "utf8")).samples.length, 0);
  await daily.tick();
  assert.equal(calls.length, 3);
});

test("the next daily summary revises the prior snapshot instead of appending a second one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-revision-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T19:55:00Z");
  let published = ["原来更爱短句"];
  const prompts = [];
  const codex = { model: "test", async startThread(options) { return options.threadId; },
    async runTurn(options) {
      prompts.push(options.prompt);
      return { text: JSON.stringify({ styleRules: [prompts.length === 1 ? "短句优先" : "短句优先，偶尔分行"] }) };
    }, async deleteThread() {} };
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona: { getPublishedStyleRules: () => [...published], async publishDailyUpdate({ rules }) { published = rules; } },
    codex, gate: new AgentTaskGate(), clock: () => now });
  await daily.init();
  await daily.capture(plainPayload("好"), ownerMessage(1));
  now = new Date("2026-09-27T20:01:00Z");
  await daily.tick();
  assert.deepEqual(published, ["短句优先"]);
  now = new Date("2026-09-28T19:55:00Z");
  await daily.capture(plainPayload("这么好"), ownerMessage(2));
  now = new Date("2026-09-28T20:01:00Z");
  await daily.tick();
  assert.deepEqual(published, ["短句优先，偶尔分行"]);
  assert.match(prompts[1], /上一版发言风格摘要.*短句优先/);
  assert.equal(daily.snapshot().pendingSamples, 0);
});

test("failed isolated summary retains samples and retries only after backoff", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-failed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T19:55:00Z");
  let attempts = 0;
  const codex = { model: "test", async startThread(options) { attempts++; return options.threadId; },
    async runTurn() { return { text: "not json" }; }, async deleteThread() {} };
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona: { async publishDailyUpdate() { throw new Error("must not publish"); } }, codex,
    gate: new AgentTaskGate(), clock: () => now });
  await daily.init();
  await daily.capture(plainPayload("先说结论"), ownerMessage(9));
  now = new Date("2026-09-27T20:01:00Z");
  await daily.tick();
  assert.equal(daily.snapshot().status, "failed");
  assert.equal(daily.snapshot().pendingSamples, 1);
  await daily.tick();
  assert.equal(attempts, 1);
  now = new Date("2026-09-27T21:02:00Z");
  await daily.tick();
  assert.equal(attempts, 2);
});

test("due catchphrases publish at 04:00 without samples or a new AI thread", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-catchphrase-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T20:01:00Z");
  let pending = true;
  let published = null;
  let prompt = null;
  const codex = { model: "test", setSystemPrompt(value) { prompt = value; },
    async startThread() { throw new Error("must not start AI"); } };
  const persona = {
    pendingCatchphrasesDue: () => pending,
    async publishDailyUpdate(value) { published = value; pending = false; },
    systemPromptForClient: () => "updated persona"
  };
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona, codex, gate: new AgentTaskGate(), clock: () => now });
  await daily.init();
  await daily.tick();
  assert.deepEqual(published, { rules: null, cutoff: "2026-09-27T20:00:00.000Z", summarizedAt: now.toISOString() });
  assert.equal(prompt, "updated persona");
  assert.equal(daily.snapshot().lastCompletedCutoff, "2026-09-27T20:00:00.000Z");
});

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
});

test("daily summary waits for active replies, publishes once, cleans ephemeral thread and raw samples", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-daily-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T19:50:00Z");
  const calls = [];
  let published = [];
  const codex = {
    model: "test-model",
    async startThread(options) { calls.push(["start", options]); return options.threadId; },
    async runTurn(options) { calls.push(["turn", options]); return { text: '{"styleRules":["短句直接，不爱用逗号"]}' }; },
    async deleteThread(id, options) { calls.push(["delete", id, options]); }
  };
  const gate = new AgentTaskGate();
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona: { async publishStyleRules(rules) { published = rules; } }, codex, gate, clock: () => now });
  await daily.init();
  assert.equal(await daily.capture(plainPayload("这么好"), ownerMessage(1)), true);
  assert.equal(await daily.capture(plainPayload("这么好"), ownerMessage(1)), false);
  assert.equal(daily.snapshot().pendingSamples, 1);
  await daily.tick();
  assert.equal(calls.length, 0);
  const release = gate.tryEnter();
  now = new Date("2026-09-27T20:01:00Z");
  const running = daily.tick();
  assert.equal(gate.blocked, true);
  assert.equal(calls.length, 0);
  release();
  await running;
  assert.deepEqual(published, ["短句直接，不爱用逗号"]);
  assert.deepEqual(calls.map(([kind]) => kind), ["start", "turn", "delete"]);
  assert.equal(calls[0][1].ephemeral, true);
  assert.equal(calls[1][1].workingMode, "ask");
  assert.equal(calls[1][1].prefetchQqMessages, false);
  assert.equal(daily.snapshot().pendingSamples, 0);
  assert.equal(JSON.parse(await readFile(join(directory, "samples.json"), "utf8")).samples.length, 0);
  await daily.tick();
  assert.equal(calls.length, 3);
});

test("failed isolated summary retains samples and retries only after backoff", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-style-failed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = new Date("2026-09-27T19:55:00Z");
  let attempts = 0;
  const codex = { model: "test", async startThread(options) { attempts++; return options.threadId; },
    async runTurn() { return { text: "not json" }; }, async deleteThread() {} };
  const daily = new DailyStyleCoordinator({ filePath: join(directory, "samples.json"), workspaceRoot: join(directory, "jobs"),
    persona: { async publishStyleRules() { throw new Error("must not publish"); } }, codex,
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

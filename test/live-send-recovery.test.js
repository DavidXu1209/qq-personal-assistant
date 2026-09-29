import test from "node:test";
import assert from "node:assert/strict";
import { runLiveTurnWithSendRecovery } from "../src/qq/live-send-recovery.js";

test("unsent final text gets one same-thread MCP chance, never a gateway send", async () => {
  const context = { liveMode: true, readCalled: true, actionCount: 0, failed: false, ended: false };
  const requests = [];
  const result = await runLiveTurnWithSendRecovery(async (request) => {
    requests.push(request);
    if (requests.length === 1) return { text: "想发到 QQ 的正文", turnId: "first", compacted: true };
    context.actionCount = 1; // Only the Agent's MCP tool can set this.
    return { text: "", turnId: "second", compacted: false };
  }, { prompt: "原消息", imagePaths: ["/image.png"], qqToolContext: context });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].qqToolContext, context);
  assert.equal(requests[1].prefetchQqMessages, false);
  assert.deepEqual(requests[1].imagePaths, []);
  assert.match(requests[1].prompt, /亲自调用.*发送工具/);
  assert.equal(result.turnId, "second");
  assert.equal(result.compacted, true);
});

test("recovery never runs after a sent action, explicit end, empty answer or failed read", async () => {
  for (const context of [
    { liveMode: true, readCalled: true, actionCount: 1 },
    { liveMode: true, readCalled: true, actionCount: 0, ended: true },
    { liveMode: true, readCalled: false, actionCount: 0 },
    { liveMode: true, readCalled: true, actionCount: 0, failed: true }
  ]) {
    let count = 0;
    await runLiveTurnWithSendRecovery(async () => { count++; return { text: "正文" }; }, { qqToolContext: context });
    assert.equal(count, 1);
  }
  let count = 0;
  await runLiveTurnWithSendRecovery(async () => { count++; return { text: "" }; }, {
    qqToolContext: { liveMode: true, readCalled: true, actionCount: 0 }
  });
  assert.equal(count, 1);
});

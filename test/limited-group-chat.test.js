import test from "node:test";
import assert from "node:assert/strict";
import { generateGroupReply, createLimitedGroupChat } from "../src/groups/limited-chat.js";

const client = { model: "gemini-primary-flash", apiBase: "https://example.invalid/v1beta", apiKey: "private-test-canary" };
const body = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };
const answer = text => Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
const silent = { info() {}, warn() {} };

test("503 retries once then uses an explicit Flash fallback without tools", async () => {
  const calls = [], waits = [], logs = [];
  const result = await generateGroupReply({ client, body, fallbackModels: ["gemini-backup-flash", "gemini-4-argon", "gemini-flash-image"],
    wait: async ms => waits.push(ms), logger: { warn: x => logs.push(x) },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      return calls.length < 3 ? new Response("sensitive provider error", { status: 503 }) : answer("你好");
    } });
  assert.equal(result, "你好");
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /gemini-backup-flash:generateContent$/);
  assert.deepEqual(waits, [1500, 3000]);
  assert.ok(calls.every(c => !c.body.tools));
  assert.ok(!logs.join().includes(client.apiKey));
  assert.ok(!logs.join().includes("sensitive"));
});

test("authorization and invalid request errors do not retry or change model", async () => {
  for (const status of [400, 401, 403]) {
    let calls = 0;
    await assert.rejects(generateGroupReply({ client, body, fallbackModels: ["gemini-backup-flash"], logger: silent,
      wait: async () => {}, fetchImpl: async () => { calls++; return new Response("", { status }); } }), { code: `HTTP_${status}` });
    assert.equal(calls, 1);
  }
});

test("404 skips repeated missing model and tries configured fallback", async () => {
  let calls = 0;
  assert.equal(await generateGroupReply({ client, body, fallbackModels: ["gemini-backup-flash"], logger: silent,
    wait: async () => {}, fetchImpl: async () => ++calls === 1 ? new Response("", { status: 404 }) : answer("OK") }), "OK");
  assert.equal(calls, 2);
});

test("network failures are bounded and raw errors do not escape", async () => {
  let calls = 0;
  await assert.rejects(generateGroupReply({ client, body, logger: silent, wait: async () => {},
    fetchImpl: async () => { calls++; throw new Error(client.apiKey); } }), { code: "NETWORK_OR_TIMEOUT" });
  assert.equal(calls, 2);
});

test("model safety refusal is not retried", async () => {
  let calls = 0;
  assert.equal(await generateGroupReply({ client, body, logger: silent, fetchImpl: async () => {
    calls++; return Response.json({ promptFeedback: { blockReason: "SAFETY" } });
  } }), "");
  assert.equal(calls, 1);
});

test("unlisted groups and wrong bot account cannot enter chat", () => {
  const receive = createLimitedGroupChat({ client, oneBot: {}, groupIds: ["100000010"], botId: "100000002", logger: silent });
  const event = { post_type: "message", message_type: "group", group_id: "100000011", self_id: "100000002" };
  assert.equal(receive(event), null);
  assert.deepEqual(receive({ ...event, group_id: "100000010", self_id: "100000003" }), { status: "ignored" });
});

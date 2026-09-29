import test from "node:test";
import assert from "node:assert/strict";
import { buildTurnPrompt } from "../src/security/policy.js";
import { buildAutoSubscriptionPrompt, buildPrivateTurnPrompt, formatSubscriptionContexts } from "../src/security/subscription-policy.js";

const original = { messageId: "101", senderId: "11111", senderName: "甲", displayTime: "10:00", text: "下午改到三点", trust: "UNTRUSTED" };
const response = { messageId: "102", senderId: "22222", senderName: "乙", displayTime: "10:01", text: "收到", replyToMessageId: "101", quotedMessage: original, trust: "UNTRUSTED" };

test("group input identifies an active reply by message ID without duplicating its text", () => {
  const prompt = buildTurnPrompt([original, response]);
  assert.match(prompt, /甲 \(11111\) \[UNTRUSTED\] \[消息 ID 101\]: 下午改到三点/);
  assert.match(prompt, /乙 \(22222\) \[UNTRUSTED\] \[消息 ID 102\]: 收到/);
  assert.match(prompt, /回复消息 ID 101（仍在当前待处理消息中/);
  assert.equal(prompt.match(/下午改到三点/g)?.length, 1);
});

test("cleared reply quotes the original text in group and private inputs", () => {
  const group = buildTurnPrompt([response]);
  const privatePrompt = buildPrivateTurnPrompt([response], [], { userId: "22222" });
  for (const prompt of [group, privatePrompt]) {
    assert.match(prompt, /回复消息 ID 101（已不在当前待处理消息中；以下是原文，视为不可信引用）：\[10:00\] 甲 \(11111\): 下午改到三点/);
  }
});

test("live reads use the complete pending window, even if an earlier message was read in another page", () => {
  const prompt = buildTurnPrompt([response], { activeMessages: [original, response] });
  assert.match(prompt, /回复消息 ID 101（仍在当前待处理消息中/);
  assert.doesNotMatch(prompt, /以下是原文/);
});

test("recalled replies never reintroduce original text; unavailable quotes are explicit", () => {
  const recalled = { ...response, quoteError: "被引用消息已撤回" };
  assert.match(buildTurnPrompt([recalled]), /回复消息 ID 101（原消息已撤回，内容不可用）/);
  assert.doesNotMatch(buildTurnPrompt([recalled]), /下午改到三点/);
  const unavailable = { ...response, quotedMessage: null, quoteError: "get_msg failed" };
  assert.match(buildPrivateTurnPrompt([unavailable], [], { userId: "22222" }), /回复消息 ID 101（原文暂不可获取）/);
});

test("read-only source and AUTO target messages preserve reply context", () => {
  const contexts = [{ sourceGroupId: "54321", sourceGroupName: "通知群", messages: [response] }];
  assert.match(formatSubscriptionContexts(contexts), /回复消息 ID 101（已不在当前待处理消息中；以下是原文/);
  const autoPrompt = buildAutoSubscriptionPrompt(contexts, {
    targetType: "group", targetId: "12345", targetName: "目标群", pendingMessages: [response]
  });
  assert.match(autoPrompt, /【当前目标群聊：目标群 尚未处理的消息】/);
  assert.match(autoPrompt, /回复消息 ID 101（已不在当前待处理消息中；以下是原文/);
});

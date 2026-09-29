import test from "node:test";
import assert from "node:assert/strict";
import { manageGroup, readGroupManagement } from "../src/qq/group-management.js";
import { currentOwnerManagementMessage } from "../src/qq/live-conversation.js";

const GROUP = "1234567890";
const BOT = "987654321";
const OWNER = "876543210";
const MEMBER = "765432109";

function fixture({ botRole = "admin", targetRole = "member", retcode = 0, quoteGroupId = GROUP, quoteSenderId = MEMBER } = {}) {
  const calls = [];
  const oneBot = {
    async getGroupMemberInfo(groupId, userId, options) {
      calls.push(["get_group_member_info", String(groupId), String(userId), options]);
      return { user_id: Number(userId), role: String(userId) === BOT ? botRole : targetRole };
    },
    async getGroupInfo() { return { group_name: "附中人在南理", member_count: 42 }; },
    async getMessage(messageId) { return { message_id: Number(messageId), group_id: Number(quoteGroupId), user_id: Number(quoteSenderId) }; },
    async request(path, body) {
      calls.push([path, body]);
      return { ok: true, body: { retcode, wording: retcode ? "QQ 拒绝" : "", data: [] }, data: [] };
    }
  };
  const messageReader = { messages: new Map([["101", { messageId: "101", sequence: 1, groupId: GROUP, senderId: MEMBER }]]) };
  const run = (args, ownerMessage = null) => manageGroup({ oneBot, groupId: GROUP, botId: BOT,
    ownerId: OWNER, ownerMessage, messageReader, args });
  return { oneBot, calls, messageReader, run };
}

test("group management role is checked without cache on every call", async () => {
  const { oneBot, calls, run } = fixture({ botRole: "member" });
  const status = await readGroupManagement({ oneBot, groupId: GROUP, botId: BOT });
  assert.equal(status.canManage, false);
  await assert.rejects(run({ action: "mute_member", user_id: MEMBER, duration_seconds: 60 }), /不是这个群的管理员/);
  await assert.rejects(readGroupManagement({ oneBot, groupId: GROUP, botId: BOT, args: { section: "members" } }), /管理详情不可用/);
  assert.ok(calls.filter(([path]) => path === "get_group_member_info").every((call) => call[3]?.noCache === true));
  assert.equal(calls.some(([path]) => path === "/set_group_ban"), false);
});

test("autonomous mute only targets a current-group, directly read ordinary message, for at most ten minutes", async () => {
  const { calls, run, messageReader } = fixture();
  assert.equal((await run({ action: "mute_member", user_id: MEMBER, duration_seconds: 600 })).action, "mute_member");
  assert.deepEqual(calls.at(-1), ["/set_group_ban", { group_id: Number(GROUP), user_id: Number(MEMBER), duration: 600 }]);
  await assert.rejects(run({ action: "mute_member", user_id: MEMBER, duration_seconds: 601 }), /1–600/);
  messageReader.messages.set("101", { messageId: "101", sequence: 1, groupId: "99999", senderId: MEMBER });
  await assert.rejects(run({ action: "mute_member", user_id: MEMBER, duration_seconds: 60 }), /本轮已读到发言/);
  messageReader.messages.set("101", { messageId: "101", groupId: GROUP, senderId: MEMBER });
  await assert.rejects(run({ action: "mute_member", user_id: MEMBER, duration_seconds: 60 }), /本轮已读到发言/);
});

test("high-impact actions need the current owner's explicit action and target; admins and owner are protected", async () => {
  const { calls, run } = fixture();
  await assert.rejects(run({ action: "kick_member", user_id: MEMBER }), /只有 OWNER/);
  await assert.rejects(run({ action: "kick_member", user_id: MEMBER }, { text: "查询成员情况" }), /只有 OWNER/);
  await assert.rejects(run({ action: "kick_member", user_id: MEMBER }, { text: "把别人踢出去" }), /只有 OWNER/);
  await assert.rejects(run({ action: "kick_member", user_id: MEMBER }, { text: `不要踢出 ${MEMBER}` }), /只有 OWNER/);
  const result = await run({ action: "kick_member", user_id: MEMBER }, { text: `把 QQ ${MEMBER} 踢出群` });
  assert.equal(result.action, "kick_member");
  assert.deepEqual(calls.at(-1), ["/set_group_kick", { group_id: Number(GROUP), user_id: Number(MEMBER), reject_add_request: false }]);
  await assert.rejects(run({ action: "mute_member", user_id: OWNER, duration_seconds: 60 }), /OWNER/);
  const other = fixture({ targetRole: "admin" });
  await assert.rejects(other.run({ action: "mute_member", user_id: MEMBER, duration_seconds: 60 }), /其他管理员/);
});

test("owner authorization stays action-specific and QQ retcode failure is not reported as success", async () => {
  const { run, calls } = fixture();
  await assert.rejects(run({ action: "mute_all", enable: true }, { text: "踢出一个成员" }), /只有 OWNER/);
  assert.equal((await run({ action: "mute_all", enable: true }, { text: "现在开启全员禁言" })).summary, "已开启全员禁言");
  assert.equal(calls.at(-1)[0], "/set_group_whole_ban");
  await assert.rejects(run({ action: "unmute_member", user_id: MEMBER }), /只有 OWNER/);
  assert.equal((await run({ action: "unmute_member", user_id: MEMBER }, { text: `解除 QQ ${MEMBER} 的禁言` })).summary,
    `已解除 QQ ${MEMBER} 的禁言`);
  assert.deepEqual(calls.at(-1), ["/set_group_ban", { group_id: Number(GROUP), user_id: Number(MEMBER), duration: 0 }]);
  const failed = fixture({ retcode: 100 });
  await assert.rejects(failed.run({ action: "mute_member", user_id: MEMBER, duration_seconds: 60 }), /QQ 拒绝/);
});

test("OWNER can unmute an explicitly mentioned member or the author of a verified replied-to group message", async () => {
  const { run } = fixture();
  await run({ action: "unmute_member", user_id: MEMBER }, {
    text: "解除他的禁言", mentions: [{ userId: MEMBER }]
  });
  await run({ action: "unmute_member", user_id: MEMBER }, {
    text: "解除这个人的禁言", replyToMessageId: "101"
  });
  await assert.rejects(run({ action: "unmute_member", user_id: MEMBER }, { text: "解除禁言" }), /只有 OWNER/);
  await assert.rejects(fixture({ quoteGroupId: "99999" }).run({ action: "unmute_member", user_id: MEMBER }, {
    text: "解除这个人的禁言", replyToMessageId: "101"
  }), /只有 OWNER/);
  await assert.rejects(fixture({ quoteSenderId: "123456780" }).run({ action: "unmute_member", user_id: MEMBER }, {
    text: "解除这个人的禁言", replyToMessageId: "101"
  }), /只有 OWNER/);
});

test("management authorization uses the newest directly read OWNER message, including one received mid-conversation", () => {
  const messages = new Map([
    ["101", { messageId: "101", sequence: 1, groupId: GROUP, senderId: OWNER, trust: "OWNER", source: "qq", text: "禁言一下" }],
    ["102", { messageId: "102", sequence: 2, groupId: GROUP, senderId: MEMBER, trust: "UNTRUSTED", source: "qq", text: "解封我" }],
    ["103", { messageId: "103", sequence: 3, groupId: GROUP, senderId: OWNER, trust: "OWNER", source: "qq", text: "解除禁言" }],
    ["quote", { messageId: "104", groupId: GROUP, senderId: OWNER, trust: "OWNER", source: "qq", text: "伪造的引用" }]
  ]);
  assert.equal(currentOwnerManagementMessage({ messages }, GROUP, OWNER)?.messageId, "103");
  assert.equal(currentOwnerManagementMessage({ messages }, GROUP, OWNER, (id) => id === "103")?.messageId, "101");
  assert.equal(currentOwnerManagementMessage({ messages }, "another-group", OWNER), null);
});

test("bot admin cannot use owner-only QQ endpoints, native bulk-kick is one call", async () => {
  const { run } = fixture();
  await assert.rejects(run({ action: "set_admin", user_id: MEMBER, enable: true }, { text: `把 ${MEMBER} 设为管理员` }), /只允许群主/);
  const ownerBot = fixture({ botRole: "owner" });
  const ids = [MEMBER, "123456780"];
  await ownerBot.run({ action: "kick_members", user_ids: ids }, { text: `把 ${ids.join(" 和 ")} 踢出群` });
  assert.deepEqual(ownerBot.calls.at(-1), ["/set_group_kick_members", {
    group_id: Number(GROUP), user_id: ids.map(Number), reject_add_request: false
  }]);
});

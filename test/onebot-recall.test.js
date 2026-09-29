import test from "node:test";
import assert from "node:assert/strict";
import { OneBotClient } from "../src/qq/onebot-client.js";

test("OneBot delete_msg accepts a signed QQ message ID and requires protocol success", async () => {
  const requests = [];
  const client = new OneBotClient({ baseUrl: "http://127.0.0.1:3000", fetchImpl: async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ status: "ok", retcode: 0, data: null }) };
  } });
  assert.equal((await client.deleteMessage("-123")).ok, true);
  assert.deepEqual(requests[0], { url: "http://127.0.0.1:3000/delete_msg", body: { message_id: -123 } });
  await assert.rejects(() => client.deleteMessage("not-an-id"), /无效/);
  assert.equal(requests.length, 1);
  client.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: "ok", retcode: 1201, wording: "消息不存在" }) });
  await assert.rejects(() => client.deleteMessage("123"), /消息不存在/);
});

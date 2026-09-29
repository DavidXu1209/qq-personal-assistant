import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TargetAllowlistSettings } from "../src/storage/target-allowlist-settings.js";
import { TriggerManager } from "../src/groups/trigger-manager.js";

test("group and private whitelist additions persist without overwriting unrelated settings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-target-allowlist-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "settings.json");
  const store = new TargetAllowlistSettings({ filePath, settings: {
    ai: { model: "hy3" }, qq: { allowedGroups: ["100000001"], privateAgentUsers: ["200000001"], files: { maxImageBytes: 1 } }
  } });
  const [group, privateChat] = await Promise.all([
    store.add("group", "100000002"),
    store.add("private", "200000002")
  ]);
  assert.equal(group.added, true);
  assert.equal(privateChat.added, true);
  assert.deepEqual(store.list("group"), ["100000001", "100000002"]);
  assert.deepEqual(store.list("private"), ["200000001", "200000002"]);
  assert.equal((await store.add("group", "100000002")).added, false);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), {
    ai: { model: "hy3" },
    qq: { allowedGroups: ["100000001", "100000002"], privateAgentUsers: ["200000001", "200000002"], files: { maxImageBytes: 1 } }
  });
  assert.throws(() => store.add("group", "not-a-qq-id"), /Invalid QQ target id/);
});

test("a newly allowed group is immediately eligible without replaying old pending messages", () => {
  const conversation = { groupId: "300000001", pendingMessages: [{ sequence: 7 }] };
  const manager = new TriggerManager({
    store: { listGroups: () => [conversation], snapshot: () => conversation },
    allowedGroups: ["300000002"]
  });
  assert.equal(manager.isAllowed("300000001"), false);
  manager.allowGroup("300000001");
  assert.equal(manager.isAllowed("300000001"), true);
  assert.equal(manager.startupPendingSequence.get("300000001"), 7);
});

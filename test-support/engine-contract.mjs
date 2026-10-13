import assert from "node:assert/strict";

export async function assertEngineContract(client, { resumeError, modelId = null } = {}) {
  const capabilities = client.capabilities();
  assert.equal(typeof capabilities.systemPrompt, "boolean");
  assert.equal(typeof capabilities.qqMcp, "boolean");
  assert.equal(typeof capabilities.deleteThread, "boolean");
  assert.equal(capabilities.persistentThreads, true);
  assert.equal(capabilities.streaming, true);
  if (capabilities.systemPrompt) assert.equal(typeof client.setSystemPrompt, "function");
  if (capabilities.deleteThread) assert.equal(typeof client.deleteThread, "function");

  const threadId = await client.startThread();
  assert.equal(typeof threadId, "string");
  assert.ok(threadId);
  assert.equal(await client.resumeThread(threadId), threadId);
  let streamed = "";
  const result = await client.runTurn({
    groupId: "contract-group",
    threadId,
    prompt: "contract-hello",
    onDelta: (delta, full) => {
      streamed += delta;
      assert.equal(full, streamed);
    }
  });
  assert.equal(result.threadId, threadId);
  assert.equal(typeof result.turnId, "string");
  assert.ok(result.text);
  assert.equal(streamed, result.text);
  const again = await client.runTurn({
    groupId: "contract-group",
    threadId,
    prompt: "contract-again",
    onDelta: () => {}
  });
  assert.equal(again.threadId, threadId);
  const loaded = (await client.listLoadedThreads()).map(String);
  assert.ok(loaded.includes(String(threadId)));
  const models = await client.listModels();
  assert.ok(Array.isArray(models) && models.length > 0);
  assert.ok(models.some((item) => item.model || item.id));
  if (modelId) assert.ok(models.some((item) => item.model === modelId || item.id === modelId));
  if (capabilities.deleteThread) {
    assert.equal((await client.deleteThread(threadId)).deleted, true);
    assert.equal((await client.listLoadedThreads()).map(String).includes(String(threadId)), false);
    await assert.rejects(client.resumeThread(threadId), resumeError);
  }
  await assert.rejects(client.resumeThread("missing-thread-contract"), resumeError);
  assert.deepEqual(client.activeGroups(), []);
  await client.close();
}

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CodexClient } from "../src/codex/client.js";
import { GeminiClient } from "../src/gemini/client.js";
import { WorkBuddyClient } from "../src/workbuddy/client.js";
import { createEngineClient, resolveEngineKind, resolveEngineProfile } from "../src/engines/factory.js";

test("engine selection keeps the platform default and accepts gemini", () => {
  assert.equal(resolveEngineKind({}, "win32"), "codex");
  assert.equal(resolveEngineKind({}, "linux"), "workbuddy");
  assert.equal(resolveEngineKind({ CODEX_REMOTE_CONTACT_ENGINE: "CODEX" }, "linux"), "codex");
  assert.equal(resolveEngineKind({ CODEX_REMOTE_CONTACT_ENGINE: "gemini" }, "win32"), "gemini");
  assert.equal(resolveEngineKind({ CODEX_REMOTE_CONTACT_ENGINE: "workbuddy" }, "win32"), "workbuddy");
  assert.equal(resolveEngineKind({ CODEX_REMOTE_CONTACT_ENGINE: "something-else" }, "win32"), "workbuddy");
});

test("model namespaces stay separated across backends", () => {
  const settings = { ai: { model: "gpt-5.6-luna", reasoningEffort: "xhigh" } };
  const codex = resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "codex" }, settings, platform: "linux" });
  assert.equal(codex.model, "gpt-5.6-luna");
  assert.equal(codex.effort, "xhigh");
  assert.equal(codex.provider, "codex-app-server");
  assert.equal(codex.migrateConversations, false);
  assert.ok(codex.contextTokenOptions.some((item) => item.value === 200_000));
  assert.equal(codex.contextTokenOptions.some((item) => item.value === "auto"), false);

  const workbuddy = resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "workbuddy" }, settings, platform: "linux" });
  assert.equal(workbuddy.model, "auto");
  assert.equal(workbuddy.provider, "workbuddy-agent-sdk");
  assert.equal(workbuddy.migrateConversations, true);
  assert.equal(workbuddy.resolveContextTokenLimit(50_000), 100_000);
  assert.ok(workbuddy.contextTokenOptions.some((item) => item.value === "auto"));
  assert.equal(workbuddy.fallbackModels("hy3", "low").some((item) => item.model === "hy3"), true);

  const gemini = resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "gemini", GEMINI_MODEL: "models/gemini-3.6-flash" }, settings, platform: "win32" });
  assert.equal(gemini.model, "gemini-3.6-flash");
  assert.equal(gemini.effort, "high");
  assert.equal(gemini.provider, "gemini-api");
  assert.equal(gemini.resolveContextTokenLimit(null), 200_000);
  assert.ok(gemini.contextTokenOptions.some((item) => item.value === 1_048_576));
  assert.equal(gemini.fallbackModels(gemini.model, gemini.effort).find((item) => item.model === "gemini-3.6-flash").isDefault, true);
  assert.deepEqual(gemini.fallbackModels()[0].supportedReasoningEfforts.map((item) => item.reasoningEffort), ["low", "medium", "high"]);
});

test("a saved Gemini model is reused only when it is a Gemini id", () => {
  const fromSettings = resolveEngineProfile({
    env: { CODEX_REMOTE_CONTACT_ENGINE: "gemini" },
    settings: { ai: { model: "gemini-3.6-flash" } },
    platform: "linux"
  });
  assert.equal(fromSettings.model, "gemini-3.6-flash");
  const ignored = resolveEngineProfile({
    env: { CODEX_REMOTE_CONTACT_ENGINE: "gemini" },
    settings: { ai: { model: "gpt-5.6-luna" } },
    platform: "linux"
  });
  assert.equal(ignored.model, "gemini-3.8-flash");
});

test("the factory returns the selected client without spawning it", () => {
  const codex = createEngineClient(resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "codex" }, platform: "linux" }), {
    executable: "codex", cwd: "/tmp", personalCwd: "/tmp/personal", personalMode: true
  });
  assert.ok(codex instanceof CodexClient);
  assert.equal(codex.cwd, "/tmp/personal");
  assert.deepEqual(codex.capabilities(), {
    systemPrompt: false, qqMcp: false, deleteThread: false, persistentThreads: true, streaming: true
  });

  const workbuddy = createEngineClient(resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "workbuddy" }, platform: "linux" }), { cwd: "/tmp" });
  assert.ok(workbuddy instanceof WorkBuddyClient);
  assert.equal(workbuddy.supportsQqMcp, true);
  assert.equal(workbuddy.capabilities().systemPrompt, true);

  const gemini = createEngineClient(resolveEngineProfile({ env: { CODEX_REMOTE_CONTACT_ENGINE: "gemini" }, platform: "win32" }), {
    cwd: "/tmp", env: { GEMINI_API_KEY: "test-gemini-key" }
  });
  assert.ok(gemini instanceof GeminiClient);
  assert.equal(gemini.apiKey, "test-gemini-key");
  assert.equal(gemini.model, "gemini-3.8-flash");
  assert.equal(gemini.capabilities().qqMcp, true);
});

test("Windows startup uses Gemini without requiring Codex when the env file selects it", async () => {
  const script = await readFile(fileURLToPath(new URL("../scripts/start-windows.ps1", import.meta.url)), "utf8");
  const geminiBranch = script.slice(script.indexOf('if ($engine -eq "gemini")'), script.indexOf("} else {"));
  assert.match(geminiBranch, /GEMINI_API_KEY/);
  assert.match(geminiBranch, /aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(geminiBranch, /Codex executable not found/);
  assert.match(script, /\$env:CODEX_REMOTE_CONTACT_ENGINE = "codex"/);
});

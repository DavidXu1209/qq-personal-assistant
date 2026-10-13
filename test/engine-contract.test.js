import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexClient, CodexResumeError } from "../src/codex/client.js";
import { GeminiClient, GeminiResumeError } from "../src/gemini/client.js";
import { assertEngineContract } from "../test-support/engine-contract.mjs";

test("Codex and Gemini clients satisfy the same persistent-thread contract", async (t) => {
  const fixturePath = fileURLToPath(new URL("../test-support/fake-codex-app-server.mjs", import.meta.url));
  const codex = new CodexClient({
    executable: process.execPath,
    executableArgs: [fixturePath],
    cwd: process.cwd(),
    model: "test-model",
    effort: "low",
    timeoutMs: 2000
  });
  t.after(() => codex.close());
  await assertEngineContract(codex, { resumeError: CodexResumeError, modelId: "test-model" });

  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-contract-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  const gemini = new GeminiClient({
    apiKey: "test-gemini-key",
    model: "gemini-3.8-flash",
    threadsDir,
    env: {},
    fetch: contractFetch
  });
  t.after(() => gemini.close());
  await assertEngineContract(gemini, { resumeError: GeminiResumeError, modelId: "gemini-3.8-flash" });
});

function contractFetch(url, options) {
  const target = new URL(url);
  if (options.method === "GET") {
    return Response.json({
      models: [
        { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/text-embedding-004", displayName: "Embed", supportedGenerationMethods: ["embedContent"] }
      ]
    });
  }
  const events = [
    { candidates: [{ content: { role: "model", parts: [{ text: "合约" }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "通过" }] }, finishReason: "STOP" }] }
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

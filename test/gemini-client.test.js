import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiClient, GeminiTurnCancelledError } from "../src/gemini/client.js";
import { composeGeminiSystemPrompt, resolveGeminiPersonaOverride } from "../src/gemini/persona.js";
import { geminiToolDeclarations } from "../src/gemini/tools.js";
import { personalTurnOutputSchema } from "../src/automation/personal-turn.js";

const API_KEY = "test-gemini-key";

test("Gemini streams text, keeps a system prompt, and stores thought signatures", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-client-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  const requests = [];
  const client = new GeminiClient({
    apiKey: API_KEY,
    model: "gemini-3.8-flash",
    threadsDir,
    env: {},
    fetch: (url, options) => {
      requests.push({ url: String(url), options });
      const body = JSON.parse(options.body);
      if (body.contents.some((message) => message.parts?.some((part) => part.functionResponse))) {
        return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "已处理", thoughtSignature: "sig-final" }] }, finishReason: "STOP" }] }]);
      }
      return sse([{
        candidates: [{
          content: {
            role: "model",
            parts: [{ functionCall: { name: "send_message", args: { text: "在" }, id: "call-1" }, thoughtSignature: "sig-1" }]
          },
          finishReason: "STOP"
        }]
      }]);
    }
  });
  t.after(() => client.close());
  client.setSystemPrompt("你是小代");
  const calls = [];
  const threadId = await client.startThread();
  const result = await client.runTurn({
    groupId: "100000",
    threadId,
    prompt: "你好",
    model: "gpt-5.6-luna",
    effort: "xhigh",
    prefetchQqMessages: false,
    qqToolContext: {
      liveMode: true,
      requireRead: true,
      readCalled: true,
      liveTool: async (name, args) => {
        calls.push([name, args]);
        return { isError: false, content: [{ type: "text", text: "queued" }] };
      }
    },
    onDelta: () => {}
  });
  assert.equal(result.text, "已处理");
  assert.deepEqual(calls, [["send_message", { text: "在" }]]);
  const first = JSON.parse(requests[0].options.body);
  const second = JSON.parse(requests[1].options.body);
  assert.equal(new URL(requests[0].url).pathname.endsWith("/models/gemini-3.8-flash:streamGenerateContent"), true);
  assert.equal(new URL(requests[0].url).searchParams.get("key"), null);
  assert.equal(requests[0].options.headers["x-goog-api-key"], API_KEY);
  assert.doesNotMatch(requests[0].options.body, /test-gemini-key/);
  assert.equal(first.systemInstruction.parts[0].text, "你是小代");
  assert.equal(first.generationConfig.thinkingConfig.thinkingLevel, "high");
  assert.equal(first.generationConfig.responseMimeType, undefined);
  assert.equal(second.contents[1].parts[0].thoughtSignature, "sig-1");
  assert.equal(second.contents[2].parts[0].functionResponse.id, "call-1");
  assert.equal(second.contents[2].parts[0].functionResponse.response.result, "queued");
  const names = first.tools[0].functionDeclarations.map((tool) => tool.name);
  assert.equal(names.length, 18);
  assert.ok(names.includes("send_message"));
  assert.ok(names.includes("manage_group"));
});

test("structured personal output does not advertise QQ tools", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-schema-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  let body;
  const client = new GeminiClient({
    apiKey: API_KEY,
    threadsDir,
    env: {},
    fetch: (_url, options) => {
      body = JSON.parse(options.body);
      return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "{\"reply\":\"好\",\"actions\":[]}" }] }, finishReason: "STOP" }] }]);
    }
  });
  t.after(() => client.close());
  const threadId = await client.startThread();
  const result = await client.runTurn({
    groupId: "owner",
    threadId,
    prompt: "整理",
    outputSchema: personalTurnOutputSchema(),
    qqToolContext: { targetType: "private", allowMessage: true }
  });
  assert.match(result.text, /"reply":"好"/);
  assert.equal(body.tools, undefined);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.properties.reply.type, "string");
  assert.equal(body.generationConfig.responseSchema.properties.actions.items.properties.when.nullable, true);
  assert.equal(body.generationConfig.responseSchema.additionalProperties, undefined);
});

test("source-read turns advertise only the scoped tools and keep the MCP retry error", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-source-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  let names;
  const client = new GeminiClient({
    apiKey: API_KEY,
    threadsDir,
    env: {},
    fetch: (_url, options) => {
      names = JSON.parse(options.body).tools[0].functionDeclarations.map((tool) => tool.name);
      return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "{}" }] }, finishReason: "STOP" }] }]);
    }
  });
  t.after(() => client.close());
  const threadId = await client.startThread();
  await assert.rejects(client.runTurn({
    groupId: "owner",
    threadId,
    prompt: "总结",
    prefetchQqMessages: false,
    qqToolContext: { requireSourceRead: true, sourceReadCalled: false, sourceGroupId: "12345", sourceReadContent: "通知" }
  }), /did not read the subscribed source group through MCP/);
  assert.deepEqual(names, ["read_source_messages", "read_forward_messages", "read_link"]);
  assert.deepEqual(geminiToolDeclarations({ sourceOnly: true }).map((tool) => tool.name), names);
});

test("threads survive a new client, ignore ephemeral system prompts, and compact old turns", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-persist-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  const imagePath = join(threadsDir, "pic.png");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const bodies = [];
  const fetchImpl = (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "收到" }] }, finishReason: "STOP" }] }]);
  };
  const first = new GeminiClient({ apiKey: API_KEY, threadsDir, systemPrompt: "长期人格", fetch: fetchImpl, env: {} });
  const threadId = await first.startThread();
  await first.runTurn({ groupId: "g", threadId, prompt: "第一句", imagePaths: [imagePath] });
  const second = new GeminiClient({ apiKey: API_KEY, threadsDir, systemPrompt: "长期人格", fetch: fetchImpl, env: {} });
  await second.resumeThread(threadId);
  const continued = await second.runTurn({ groupId: "g", threadId, prompt: "第二句", contextTokenLimit: 1 });
  assert.equal(continued.compacted, true);
  assert.equal(bodies[1].contents.some((message) => message.parts?.some((part) => part.text === "第一句")), false);
  assert.equal(bodies[0].contents[0].parts[1].inlineData.mimeType, "image/png");
  assert.equal(bodies[0].systemInstruction.parts[0].text, "长期人格");

  const ephemeral = await first.startThread({ threadId: "sticker-label-job" });
  await first.runTurn({ groupId: "sticker", threadId: ephemeral, prompt: "标注" });
  assert.equal(bodies.at(-1).systemInstruction, undefined);
  await first.deleteThread(ephemeral);
  await assert.rejects(second.resumeThread(ephemeral), /Unable to resume persistent Gemini thread/);
});

test("missing credentials, quota errors, and interrupts stay free of the API key", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-errors-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  const missing = new GeminiClient({ apiKey: "", threadsDir, env: {}, fetch: () => { throw new Error("must not call"); } });
  const threadId = await missing.startThread();
  await assert.rejects(missing.runTurn({ groupId: "g", threadId, prompt: "hi" }), /GEMINI_API_KEY/);

  const quota = new GeminiClient({
    apiKey: API_KEY,
    threadsDir,
    env: {},
    fetch: () => new Response(`leaked ${API_KEY}`, { status: 429, headers: { "content-type": "application/json" } })
  });
  await assert.rejects(quota.runTurn({ groupId: "g", threadId, prompt: "hi" }), (error) => {
    assert.match(error.message, /Gemini API 429/);
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(error.message, /test-gemini-key/);
    return true;
  });

  let release;
  const hung = new GeminiClient({
    apiKey: API_KEY,
    threadsDir,
    env: {},
    fetch: (_url, options) => new Promise((resolve, reject) => {
      release = resolve;
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
    })
  });
  const running = hung.runTurn({ groupId: "busy", threadId, prompt: "等" });
  for (let attempt = 0; attempt < 20 && !release; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(hung.runTurn({ groupId: "busy", threadId, prompt: "重复" }), /already has a running turn/);
  assert.deepEqual(hung.activeGroups(), ["busy"]);
  assert.equal(await hung.interruptGroup("busy"), true);
  await assert.rejects(running, (error) => {
    assert.ok(error instanceof GeminiTurnCancelledError);
    assert.equal(error.code, "CANCELLED");
    return true;
  });
  assert.deepEqual(hung.activeGroups(), []);
  const saved = JSON.parse(await readFile(join(threadsDir, `${threadId}.json`), "utf8"));
  assert.equal(saved.contents.length, 0);
});

test("listModels pages and drops models that cannot generate content", async () => {
  const calls = [];
  const client = new GeminiClient({
    apiKey: API_KEY,
    model: "gemini-3.8-flash",
    env: {},
    fetch: (url) => {
      const target = new URL(url);
      calls.push(target.searchParams.get("pageToken"));
      if (!target.searchParams.get("pageToken")) {
        return Response.json({
          models: [{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] }],
          nextPageToken: "next"
        });
      }
      return Response.json({
        models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", description: "flash", supportedGenerationMethods: ["generateContent"] }]
      });
    }
  });
  const models = await client.listModels();
  assert.deepEqual(calls, [null, "next"]);
  assert.equal(models.length, 1);
  assert.equal(models[0].model, "gemini-3.8-flash");
  assert.equal(models[0].isDefault, true);
  assert.equal(models[0].supportedReasoningEfforts.length, 3);
});

test("Gemini reuses the shared system prompt and can append or replace a persona override", async (t) => {
  const threadsDir = await mkdtemp(join(tmpdir(), "gemini-persona-"));
  t.after(() => rm(threadsDir, { recursive: true, force: true }));
  const shared = "<laodai_persona>\n你是小代。\n</laodai_persona>\n<qq_gateway_rules>\n先 read_messages。\n</qq_gateway_rules>";
  const bodies = [];
  const fetchImpl = (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return sse([{ candidates: [{ content: { role: "model", parts: [{ text: "好" }] }, finishReason: "STOP" }] }]);
  };
  const plain = new GeminiClient({ apiKey: API_KEY, threadsDir, systemPrompt: shared, fetch: fetchImpl, env: {} });
  assert.equal(plain.systemPrompt, shared);
  const plainThread = await plain.startThread();
  await plain.runTurn({ groupId: "g", threadId: plainThread, prompt: "你好" });
  assert.equal(bodies[0].systemInstruction.parts[0].text, shared);

  const appended = new GeminiClient({
    apiKey: API_KEY, threadsDir, systemPrompt: shared, fetch: fetchImpl, env: {},
    personaOverride: { mode: "append", text: "回答再短一些。" }
  });
  assert.equal(appended.systemPrompt, `${shared}\n\n回答再短一些。`);
  appended.setSystemPrompt(`${shared}\n昵称已更新`);
  assert.equal(appended.systemPrompt, `${shared}\n昵称已更新\n\n回答再短一些。`);
  const appendThread = await appended.startThread();
  await appended.runTurn({ groupId: "g2", threadId: appendThread, prompt: "你好" });
  assert.equal(bodies.at(-1).systemInstruction.parts[0].text, appended.systemPrompt);

  const replaced = new GeminiClient({
    apiKey: API_KEY, threadsDir, systemPrompt: shared, fetch: fetchImpl, env: {},
    personaOverride: { mode: "replace", text: "只使用这段 Gemini 人格。" }
  });
  assert.equal(replaced.systemPrompt, "只使用这段 Gemini 人格。");
  assert.equal(replaced.systemPrompt.includes("qq_gateway_rules"), false);
  const replaceThread = await replaced.startThread({ threadId: "sticker-label-override" });
  await replaced.runTurn({ groupId: "sticker", threadId: replaceThread, prompt: "标注" });
  assert.equal(bodies.at(-1).systemInstruction, undefined);

  const personaPath = join(threadsDir, "extra.txt");
  await writeFile(personaPath, "来自文件的补充\n");
  const fromFile = resolveGeminiPersonaOverride({
    GEMINI_PERSONA: "环境变量补充",
    GEMINI_PERSONA_FILE: personaPath,
    GEMINI_PERSONA_MODE: "append"
  });
  assert.equal(composeGeminiSystemPrompt(shared, fromFile), `${shared}\n\n环境变量补充\n\n来自文件的补充`);
  await assert.rejects(
    async () => resolveGeminiPersonaOverride({ GEMINI_PERSONA_FILE: join(threadsDir, "missing.txt") }),
    /cannot be read/
  );
  await assert.rejects(
    async () => resolveGeminiPersonaOverride({ GEMINI_PERSONA_MODE: "replace" }),
    /requires GEMINI_PERSONA/
  );
  assert.equal(resolveGeminiPersonaOverride({}).text, "");
  assert.equal(composeGeminiSystemPrompt(shared, resolveGeminiPersonaOverride({})), shared);
});

function sse(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

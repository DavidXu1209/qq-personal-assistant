import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePersonaFiles, validateRuntimeConfig } from "../src/security/runtime-config.js";
const valid = { ownerId: "100000001", botId: "100000002", host: "127.0.0.1",
  authDisabled: false, apiToken: "synthetic-test-token", oneBotToken: "synthetic-onebot-token" };
test("public release requires distinct explicitly configured identities and credentials", () => {
  assert.doesNotThrow(() => validateRuntimeConfig(valid));
  for (const overrides of [{ ownerId: "" }, { botId: "" }, { ownerId: valid.botId },
    { apiToken: "" }, { oneBotToken: "" }, { ownerId: "not-a-number" }]) {
    assert.throws(() => validateRuntimeConfig({ ...valid, ...overrides }));
  }
});
test("unauthenticated mode cannot bind to a public or LAN address", () => {
  for (const host of ["0.0.0.0", "192.168.1.20", "::"]) {
    assert.throws(() => validateRuntimeConfig({ ...valid, authDisabled: true, host }));
  }
  assert.doesNotThrow(() => validateRuntimeConfig({ ...valid, authDisabled: true, apiToken: "" }));
});
test("unconfigured sender cannot acquire OWNER trust", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import {trustForSender} from "./src/security/policy.js"; console.log(trustForSender(""), trustForSender("100000001"))'],
    { env: { ...process.env, CODEX_REMOTE_CONTACT_OWNER_QQ_ID: "" }, encoding: "utf8" });
  assert.equal(output.trim(), "UNTRUSTED UNTRUSTED");
});

test("private personality overrides resolve relative to the project, not the shell directory", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "qq-persona-config-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  for (const directory of ["persona", "config/private/persona"]) {
    const root = join(project, directory);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "core.json"), JSON.stringify({ name: "Test Agent" }));
    await writeFile(join(root, "examples.json"), JSON.stringify({ examples: [] }));
  }
  assert.equal(resolvePersonaFiles(project).corePath, join(project, "persona/core.json"));
  const privateFiles = resolvePersonaFiles(project, "config/private/persona");
  assert.equal(privateFiles.corePath, join(project, "config/private/persona/core.json"));
  assert.deepEqual(resolvePersonaFiles(project, join(project, "config/private/persona")), privateFiles);
});

test("a broken private personality never silently falls back to public templates", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "qq-persona-invalid-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const root = join(project, "config/private/persona");
  await mkdir(root, { recursive: true });
  const load = () => resolvePersonaFiles(project, "config/private/persona");
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "core.json"), JSON.stringify({ name: "Test Agent" }));
  await writeFile(join(root, "examples.json"), "invalid json");
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "examples.json"), JSON.stringify({ examples: {} }));
  assert.throws(load, /missing or invalid/);
  await writeFile(join(root, "examples.json"), JSON.stringify({ examples: [] }));
  await writeFile(join(root, "core.json"), JSON.stringify({ name: "" }));
  assert.throws(load, /missing or invalid/);
});

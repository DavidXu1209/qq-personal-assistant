import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { validateRuntimeConfig } from "../src/security/runtime-config.js";
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

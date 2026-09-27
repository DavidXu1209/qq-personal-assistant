import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const project = fileURLToPath(new URL("../", import.meta.url));
test("browser and native builds use one canonical frontend, without writing back to source", async () => {
  const build = await readFile(join(project, "modules/mac-client/script/build_and_run.sh"), "utf8");
  assert.match(build, /FRONTEND="\$PROJECT_DIR\/modules\/web-console\/public"/);
  assert.match(build, /cp "\$FRONTEND\/\$asset" "\$RESOURCES\/\$asset"/);
  assert.doesNotMatch(build, /cp [^\n]+ "\$(?:FRONTEND|PROJECT_DIR\/modules\/web-console\/public)\//);
  for (const asset of ["client.html", "client.css", "client.js"]) {
    await access(join(project, "modules/web-console/public", asset));
    await assert.rejects(access(join(project, "modules/mac-client/Resources", asset)), { code: "ENOENT" });
  }
});

test("launcher refers to the existing QQ recovery service, not an obsolete LLBot application", async () => {
  const source = await readFile(join(project, "modules/macos-launcher/Sources/CodexRemoteContactLauncher.swift"), "utf8");
  assert.doesNotMatch(source, /LLBot|qq-llbot/);
  assert.match(source, /local\.codexremotecontact\.qq-runtime/);
  assert.match(source, /Library\/LaunchAgents\/local\.codexremotecontact\.chat-hub\.plist/);
});

test("launchd configuration loader quotes values without executing shell fragments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-launch-env-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "private.env");
  const value = "$(printf unexpected) /tmp/'quoted' ; printf unsafe";
  await writeFile(envFile, `CODEX_REMOTE_CONTACT_TEST_PATH="${value}"\nUNRELATED_PRIVATE_DATA=not-exported\n`);
  const exports = execFileSync(process.execPath, ["--env-file=" + envFile, join(project, "scripts/export-runtime-env.mjs")], {
    encoding: "utf8", env: { PATH: process.env.PATH }
  });
  assert.doesNotMatch(exports, /UNRELATED_PRIVATE_DATA/);
  const result = execFileSync("/bin/sh", ["-c", exports + '\nprintf "%s" "$CODEX_REMOTE_CONTACT_TEST_PATH"'], { encoding: "utf8" });
  assert.equal(result, value);
});

test("external environment remains an explicit override of the private env file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "qq-launch-override-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const envFile = join(directory, "private.env");
  await writeFile(envFile, "CODEX_REMOTE_CONTACT_ENGINE=from-file\n");
  const exports = execFileSync(process.execPath, ["--env-file=" + envFile, join(project, "scripts/export-runtime-env.mjs")], {
    encoding: "utf8", env: { CODEX_REMOTE_CONTACT_ENGINE: "from-environment" }
  });
  assert.match(exports, /CODEX_REMOTE_CONTACT_ENGINE='from-environment'/);
});

test("missing private env is an error rather than an empty successful export", () => {
  const result = spawnSync(process.execPath, ["--env-file=" + join(project, "config/nonexistent-test.env"),
    join(project, "scripts/export-runtime-env.mjs")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("both launchd runners use checked Node dotenv exports instead of shell sourcing", async () => {
  for (const name of ["run-qq-only.command", "run-qq-runtime.command"]) {
    const script = await readFile(join(project, "modules", name), "utf8");
    assert.doesNotMatch(script, /source "\$ENV_FILE"/);
    assert.match(script, /RUNTIME_ENV_EXPORTS="\$\(.*--env-file="\$ENV_FILE".*export-runtime-env\.mjs/);
    assert.match(script, /eval "\$RUNTIME_ENV_EXPORTS"/);
  }
});

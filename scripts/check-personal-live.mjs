import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { CodexClient } from "../src/codex/client.js";
import { buildPersonalTurnPrompt, parsePersonalTurn, personalTurnOutputSchema } from "../src/automation/personal-turn.js";

// Manual check: consumes the existing Codex subscription; no QQ or calendar writes.
const root = fileURLToPath(new URL("../", import.meta.url));
const config = Object.fromEntries((await readFile(resolve(root, "config/qq-only.env"), "utf8")).split(/\r?\n/).filter(line => line.includes("=")).map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const args = [];
for (const name of ["shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "code_mode_host"]) args.push("-c", `features.${name}=false`);
for (const name of ["cua_repl", "windows-mcp", "node_repl"]) args.push("-c", `mcp_servers.${name}.enabled=false`);
const client = new CodexClient({ executable: process.env.CODEX_CLI_PATH || "codex", executableArgs: args,
  cwd: resolve(root, "runtime/personal-agent"), model: config.CODEX_REMOTE_CONTACT_CODEX_MODEL, effort: "low", timeoutMs: 120_000 });
const cases = [
  { name: "明确时间", text: "请整理并提取事项：2026年10月8日14:00在教学楼A101开班会，15:00结束。", check: result => { assert.equal(result.actions.length, 1); assert.equal(result.actions[0].start, "2026-10-08T06:00:00.000Z"); assert.equal(result.actions[0].reminderAt, "2026-10-08T05:50:00.000Z"); } },
  { name: "只有日期", text: "请整理并提取事项：2026年10月9日提交实验报告，通知没有写具体时刻。", check: result => { assert.equal(result.actions.length, 1); assert.equal(result.actions[0].start, "2026-10-09T01:00:00.000Z"); } },
  { name: "时间不明确", text: "请整理这条转发：下周找时间见面吧，日期和时刻还没确定。", check: result => assert.equal(result.actions.length, 0) }
];
try {
  for (const sample of cases) {
    const threadId = await client.startThread();
    const output = await client.runTurn({ groupId: `local-check:${sample.name}`, threadId,
      prompt: buildPersonalTurnPrompt(sample.text, { now: new Date("2026-10-07T12:00:00Z") }),
      outputSchema: personalTurnOutputSchema(), turnSandbox: { type: "readOnly" } });
    const result = parsePersonalTurn(output.text, { messageIds: [sample.name] });
    sample.check(result);
    console.log(JSON.stringify({ case: sample.name, passed: true, reply: result.reply, actions: result.actions.map(({ title, start, reminderAt }) => ({ title, start, reminderAt })) }));
  }
} finally {
  await client.close();
}

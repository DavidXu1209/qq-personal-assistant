import { spawn } from "node:child_process";
// Synthetic identities are isolated to the offline test runner, never defaults.
const child = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env,
    CODEX_REMOTE_CONTACT_OWNER_QQ_ID: "100000001",
    CODEX_REMOTE_CONTACT_BOT_QQ_ID: "100000002" }
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });

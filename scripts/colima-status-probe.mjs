import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function colimaStatusReady({ executable, profile, timeoutMs = 20_000, run = exec } = {}) {
  if (!executable || !profile) throw new Error("Colima executable and profile are required");
  try {
    await run(executable, ["status", "--profile", profile], {
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: 64 * 1024
    });
    return true;
  } catch {
    // After an OS update a stale VM status probe can hang for minutes. Let the
    // existing conservative marker recovery decide whether starting is safe.
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (!await colimaStatusReady({ executable: process.argv[2], profile: process.argv[3] })) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

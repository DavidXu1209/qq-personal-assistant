import { lstat, mkdir, readFile, realpath, rename } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const MARKERS = ["ha.pid", "vz.pid", "ha.sock", "ssh.sock"];

async function probeSocket(path) {
  return new Promise((done) => {
    const socket = createConnection({ path });
    const finish = (status) => { socket.destroy(); done(status); };
    socket.setTimeout(800, () => finish("unknown"));
    socket.once("connect", () => finish("active"));
    socket.once("error", (error) => finish(["ENOENT", "ECONNREFUSED"].includes(error.code) ? "stale" : "unknown"));
  });
}

async function processCommand(pid) {
  try { return (await exec("/bin/ps", ["-p", String(pid), "-o", "comm="])).stdout.trim(); }
  catch (error) { if (error.code === 1) return ""; throw error; }
}

async function socketOwners(path) {
  try { return (await exec("/usr/sbin/lsof", ["-t", "--", path])).stdout.trim(); }
  catch (error) { if (error.code === 1) return ""; throw error; }
}

/** Move proven stale runtime markers only. Never signal a PID or touch disks. */
export async function recoverStaleColima({ instanceDir, probe = probeSocket, command = processCommand, owners = socketOwners } = {}) {
  const directory = resolve(instanceDir || "");
  if (!/^colima-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(basename(directory))
    || basename(dirname(directory)) !== "_lima" || basename(dirname(dirname(directory))) !== ".colima") {
    throw new Error("Refusing recovery outside an exact .colima/_lima/colima-* instance");
  }
  try { if (await realpath(directory) !== directory) throw new Error("Refusing a symlinked Colima instance"); }
  catch (error) { if (error.code === "ENOENT") return { status: "absent", moved: [] }; throw error; }
  const present = [];
  const verified = new Map();
  for (const name of MARKERS) {
    const path = join(directory, name);
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || !(stat.isFile() || stat.isSocket())) throw new Error(`Unsafe marker: ${name}`);
    if (name.endsWith(".pid")) {
      const value = (await readFile(path, "utf8")).trim();
      if (!/^\d+$/.test(value) || Number(value) < 2) throw new Error(`Invalid PID marker: ${name}`);
      const executable = await command(Number(value));
      if (/(^|\/)(limactl|lima|colima|qemu-system-[\w-]+)$/i.test(executable)) return { status: "active", moved: [] };
      // PIDs are routinely reused after reboot. An unrelated process is never
      // killed, including a real QQ client that now owns the old VM PID.
    } else {
      if (!stat.isSocket()) throw new Error(`Not a Unix socket: ${name}`);
      if (await owners(path)) return { status: "active", moved: [] };
      if (await probe(path) !== "stale") return { status: "active_or_unknown", moved: [] };
    }
    present.push(name);
    verified.set(name, stat);
  }
  if (!present.length) return { status: "clean", moved: [] };
  const backupRoot = join(directory, "recovery-backups");
  try {
    const stat = await lstat(backupRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing an unsafe recovery backup directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const backupDir = join(backupRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const moved = [];
  try {
    for (const name of present) {
      const current = await lstat(join(directory, name));
      const original = verified.get(name);
      if (current.ino !== original.ino || current.dev !== original.dev || current.mtimeMs !== original.mtimeMs) {
        throw new Error(`Marker changed during recovery: ${name}`);
      }
      await rename(join(directory, name), join(backupDir, name));
      moved.push(name);
    }
  } catch (error) {
    // Restore all moved markers on partial failure; do not leave half a repair.
    for (const name of moved.reverse()) await rename(join(backupDir, name), join(directory, name));
    throw error;
  }
  return { status: "recovered", moved, backupDir };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await recoverStaleColima({ instanceDir: process.argv[2] }))); }
  catch (error) { console.error(`Safe Colima recovery refused: ${error.message}`); process.exitCode = 1; }
}

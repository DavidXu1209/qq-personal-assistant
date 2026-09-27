import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { recoverStaleColima } from "../scripts/colima-stale-state.mjs";
import { QqFileManager } from "../src/qq/file-manager.js";

async function fixture(t) {
  // Unix sockets on macOS have a short path limit; /tmp is also a symlink.
  const root = await realpath(await mkdtemp("/tmp/crc-s-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const instanceDir = join(root, ".colima", "_lima", "colima-snowluma");
  await mkdir(instanceDir, { recursive: true });
  await writeFile(join(instanceDir, "disk"), "virtual-disk-must-be-retained");
  await writeFile(join(instanceDir, "ha.pid"), "1611\n");
  await writeFile(join(instanceDir, "vz.pid"), "1611\n");
  return { root, instanceDir };
}

test("stale PID reused by QQ is backed up without killing QQ or touching VM data", async (t) => {
  const f = await fixture(t);
  const result = await recoverStaleColima({ instanceDir: f.instanceDir,
    command: async () => "/Applications/QQ.app/Contents/Frameworks/QQ Helper (Renderer).app/Contents/MacOS/QQ Helper (Renderer)" });
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.moved, ["ha.pid", "vz.pid"]);
  assert.equal(await readFile(join(result.backupDir, "ha.pid"), "utf8"), "1611\n");
  assert.equal(await readFile(join(f.instanceDir, "disk"), "utf8"), "virtual-disk-must-be-retained");
  assert.deepEqual((await readdir(f.instanceDir)).sort(), ["disk", "recovery-backups"]);
});

test("a live VM hostagent prevents all runtime marker modifications", async (t) => {
  const f = await fixture(t);
  const result = await recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "/opt/homebrew/bin/limactl" });
  assert.equal(result.status, "active");
  assert.deepEqual((await readdir(f.instanceDir)).sort(), ["disk", "ha.pid", "vz.pid"]);
});

test("actual stale Unix sockets are backed up and preserved for recovery", async (t) => {
  const f = await fixture(t);
  const path = join(f.instanceDir, "ha.sock");
  const temporary = join(f.instanceDir, "disconnected.sock");
  const server = createServer();
  await new Promise((resolve) => server.listen(path, resolve));
  await rename(path, temporary);
  await new Promise((resolve) => server.close(resolve));
  await rename(temporary, path);
  const result = await recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "" });
  assert.equal(result.status, "recovered");
  assert.deepEqual(result.moved, ["ha.pid", "vz.pid", "ha.sock"]);
});

test("a socket owner or reachable hostagent prevents recovery", async (t) => {
  const f = await fixture(t);
  const path = join(f.instanceDir, "ha.sock");
  const server = createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(path, resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const owned = await recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "", owners: async () => "1234" });
  assert.equal(owned.status, "active");
  const connected = await recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "", owners: async () => "" });
  assert.equal(connected.status, "active_or_unknown");
  assert.equal(await readFile(join(f.instanceDir, "ha.pid"), "utf8"), "1611\n");
});

test("invalid markers and unknown socket errors fail closed without changing other files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.instanceDir, "vz.pid"), "not-a-pid");
  await assert.rejects(recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "" }), /Invalid PID/);
  assert.equal(await readFile(join(f.instanceDir, "ha.pid"), "utf8"), "1611\n");
  assert.equal(await readFile(join(f.instanceDir, "disk"), "utf8"), "virtual-disk-must-be-retained");
});

test("unsafe target paths and symlinked markers are refused", async (t) => {
  const f = await fixture(t);
  await assert.rejects(recoverStaleColima({ instanceDir: f.root }), /Refusing recovery/);
  await symlink(join(f.instanceDir, "disk"), join(f.instanceDir, "ha.sock"));
  await assert.rejects(recoverStaleColima({ instanceDir: f.instanceDir, command: async () => "" }), /Unsafe marker/);
  assert.equal(await readFile(join(f.instanceDir, "ha.pid"), "utf8"), "1611\n");
});

test("a clean or absent instance needs no recovery or VM data creation", async (t) => {
  const f = await fixture(t);
  const nonexistent = join(f.root, ".colima", "_lima", "colima-absent");
  assert.deepEqual(await recoverStaleColima({ instanceDir: nonexistent }), { status: "absent", moved: [] });
  await rm(join(f.instanceDir, "ha.pid"));
  await rm(join(f.instanceDir, "vz.pid"));
  assert.deepEqual(await recoverStaleColima({ instanceDir: f.instanceDir }), { status: "clean", moved: [] });
});

test("Hub startup never starts or stops the VM and the separate QQ job retries independently", async () => {
  const hub = await readFile(new URL("../modules/run-qq-only.command", import.meta.url), "utf8");
  const qq = await readFile(new URL("../modules/run-qq-runtime.command", import.meta.url), "utf8");
  const plist = await readFile(new URL("../config/local.codexremotecontact.qq-runtime.plist.example", import.meta.url), "utf8");
  assert.doesNotMatch(hub, /COLIMA_BIN|DOCKER_BIN|colima.*start|docker.*start/);
  assert.match(hub, /exec "\$NODE_BIN" src\/server\.js/);
  assert.match(qq, /colima-stale-state\.mjs/);
  assert.doesNotMatch(qq, /--force|^\s*(kill|delete|prune|rm)\s/m);
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
});

test("offline staging initialization can retry when QQ returns without clearing live jobs", async () => {
  let online = false;
  const calls = [];
  const manager = new QqFileManager({ execFileImpl: async (_executable, args) => {
    calls.push(args);
    if (!online) throw new Error("Docker offline");
  } });
  await assert.rejects(manager.init(), /Docker offline/);
  assert.equal(manager.initialized, false);
  online = true;
  calls.length = 0;
  await Promise.all([manager.init(), manager.init(), manager.init()]);
  assert.equal(calls.length, 3);
  assert.equal(manager.initialized, true);
  await manager.init();
  assert.equal(calls.length, 3);
  await manager.withStagedImage({ sourcePath: "/fixture/a.png" }, async () => {});
  assert.equal(calls.filter((args) => args.includes("rm") && args.at(-1) === manager.stagingRoot).length, 1);
});

test("sending a file initializes staging first and never delivers when Docker is offline", async () => {
  let sent = false;
  const manager = new QqFileManager({
    execFileImpl: async () => { throw new Error("Docker offline"); },
    oneBot: { uploadGroupFile: async () => { sent = true; } }
  });
  await assert.rejects(manager.upload("123", { sourcePath: "/fixture/a.zip", name: "a.zip" }), /Docker offline/);
  assert.equal(sent, false);
});

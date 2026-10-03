import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TARGET_KEYS = { group: "allowedGroups", private: "privateAgentUsers" };

export class TargetAllowlistSettings {
  constructor({ filePath, settings = {} } = {}) {
    if (!filePath) throw new Error("Target allowlist settings path is required");
    this.filePath = filePath;
    this.settings = structuredClone(settings);
    this.saveChain = Promise.resolve();
  }

  list(type) {
    const key = TARGET_KEYS[type];
    if (!key) throw new Error("Unknown allowlist target type");
    return [...new Set((this.settings.qq?.[key] || []).map((value) => String(value).trim())
      .filter((value) => /^\d{5,14}$/u.test(value) && !this.isRemoved(type, value)))];
  }

  removed(type) {
    if (!TARGET_KEYS[type]) throw new Error("Unknown allowlist target type");
    return [...new Set((this.settings.qq?.removedAgentTargets?.[type] || []).map(String)
      .filter((value) => /^\d{5,14}$/u.test(value)))];
  }

  isRemoved(type, id) { return this.removed(type).includes(String(id)); }

  remove(type, id) {
    const key = TARGET_KEYS[type];
    if (!key) throw new Error("Unknown allowlist target type");
    const targetId = String(id || "").trim();
    if (!/^\d{5,14}$/u.test(targetId)) throw new Error("Invalid QQ target id");
    const operation = this.saveChain.then(async () => {
      const next = structuredClone(this.settings);
      next.qq ||= {};
      next.qq[key] = this.list(type).filter((value) => value !== targetId);
      next.qq.removedAgentTargets ||= {};
      next.qq.removedAgentTargets[type] = [...new Set([...this.removed(type), targetId])];
      await writeSettings(this.filePath, next);
      this.settings = next;
      return { removed: true, ids: [...next.qq[key]] };
    });
    this.saveChain = operation.then(() => {}, () => {});
    return operation;
  }

  add(type, id) {
    const key = TARGET_KEYS[type];
    if (!key) throw new Error("Unknown allowlist target type");
    const targetId = String(id || "").trim();
    if (!/^\d{5,14}$/u.test(targetId)) throw new Error("Invalid QQ target id");
    const operation = this.saveChain.then(async () => {
      if (this.list(type).includes(targetId) && !this.isRemoved(type, targetId)) return { added: false, ids: this.list(type) };
      const next = structuredClone(this.settings);
      next.qq ||= {};
      next.qq[key] = [...new Set([...this.list(type), targetId])];
      if (next.qq.removedAgentTargets) next.qq.removedAgentTargets[type] = this.removed(type).filter((value) => value !== targetId);
      await writeSettings(this.filePath, next);
      this.settings = next;
      return { added: true, ids: [...next.qq[key]] };
    });
    this.saveChain = operation.then(() => {}, () => {});
    return operation;
  }
}

async function writeSettings(filePath, settings) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

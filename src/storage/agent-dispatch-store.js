import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class AgentDispatchStore {
  constructor({ filePath, clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.clock = clock;
    this.state = { version: 1, enabled: true, updatedAt: null };
    this.saveChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        version: 1,
        enabled: loaded?.enabled !== false,
        updatedAt: loaded?.updatedAt || null
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.save();
  }

  isEnabled() {
    return this.state.enabled;
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async setEnabled(enabled) {
    this.state.enabled = Boolean(enabled);
    await this.save();
    return this.snapshot();
  }

  async save() {
    this.state.updatedAt = this.clock().toISOString();
    const body = JSON.stringify(this.state, null, 2);
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(tempPath, body, { mode: 0o600 });
      await rename(tempPath, this.filePath);
    });
    return this.saveChain;
  }
}

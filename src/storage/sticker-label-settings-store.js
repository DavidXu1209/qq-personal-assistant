import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class StickerLabelSettingsStore {
  constructor({ filePath, defaultModel = "hy3", clock = () => new Date() } = {}) {
    this.filePath = filePath;
    this.defaultModel = String(defaultModel || "hy3");
    this.clock = clock;
    this.state = { version: 1, model: this.defaultModel, updatedAt: null };
    this.saveChain = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        version: 1,
        model: String(loaded?.model || this.defaultModel),
        updatedAt: loaded?.updatedAt || null
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.save();
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async setModel(model) {
    const normalized = String(model || "").trim();
    if (!normalized) throw new Error("Sticker label model is required");
    this.state.model = normalized;
    await this.save();
    return this.snapshot();
  }

  async save() {
    this.state.updatedAt = this.clock().toISOString();
    const body = JSON.stringify(this.state, null, 2);
    const temporary = `${this.filePath}.tmp-${process.pid}`;
    this.saveChain = this.saveChain.then(async () => {
      await writeFile(temporary, body, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    return this.saveChain;
  }
}

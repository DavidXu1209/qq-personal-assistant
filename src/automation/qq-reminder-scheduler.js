import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class QqReminderScheduler {
  constructor({ filePath, oneBot, ownerId, onEvent = () => {} } = {}) {
    this.filePath = filePath;
    this.oneBot = oneBot;
    this.ownerId = String(ownerId || "");
    this.onEvent = onEvent;
    this.items = [];
    this.running = false;
    this.saveQueue = Promise.resolve();
    this.lastError = null;
  }

  async init() {
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!Array.isArray(saved) || saved.some((item) => !item?.actionId || !item?.title || !Number.isFinite(Date.parse(item.reminderAt)))) throw new Error("提醒文件格式无效，请检查备份");
      this.items = saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // ponytail: retry an interrupted send after restart; a crash during QQ delivery can rarely duplicate one reminder.
    for (const item of this.items) if (item.status === "sending") item.status = "pending";
    await this.save();
  }

  async add(action) {
    if (!action?.actionId || !action?.title || !Number.isFinite(Date.parse(action.reminderAt))) throw new Error("提醒字段或日期无效");
    const key = duplicateKey(action);
    const existing = this.items.find(item => item.actionId === action.actionId || (item.duplicateKeys || [duplicateKey(item)]).includes(key));
    if (existing) { await this.save(); return { action: { ...existing }, created: false }; }
    const item = { ...action, status: "pending", duplicateKeys: [key], calendarStatus: "pending", createdAt: new Date().toISOString() };
    this.items.push(item);
    await this.save();
    return { action: { ...item }, created: true };
  }

  list(all = false) {
    return this.items.filter(item => all || item.status === "pending" || item.status === "sending" || (item.status === "sent" && Date.parse(item.start) > Date.now()))
      .map(item => ({ ...item })).sort((a, b) => Date.parse(a.start || a.reminderAt) - Date.parse(b.start || b.reminderAt));
  }

  find(id) {
    if (!/^[a-f\d]{8,24}$/i.test(id)) throw new Error("请使用查看提醒时显示的编号");
    const matches = this.items.filter(item => item.actionId.startsWith(id.toLowerCase()));
    if (matches.length !== 1) throw new Error(matches.length ? "编号不唯一，请使用完整编号" : "找不到该提醒");
    return matches[0];
  }

  async cancel(id) {
    const item = this.find(id);
    if (item.status === "sending") throw new Error("该提醒正在发送，请稍后再取消");
    item.status = "cancelled";
    await this.save();
    return { ...item };
  }

  async update(id, action) {
    const item = this.find(id);
    if (item.status === "sending") throw new Error("该提醒正在发送，请稍后再修改");
    if (!Number.isFinite(Date.parse(action.start)) || !Number.isFinite(Date.parse(action.reminderAt))) throw new Error("修改时间无效");
    const key = duplicateKey({ ...item, ...action });
    if (this.items.some(other => other !== item && other.status !== "cancelled" && duplicateKey(other) === key)) throw new Error("该时间已有相同事项，请先查看提醒");
    const duplicateKeys = [...new Set([...(item.duplicateKeys || [duplicateKey(item)]), key])];
    Object.assign(item, action, { actionId: item.actionId, status: "pending", duplicateKeys, calendarStatus: "pending", calendarError: null, sentAt: null });
    await this.save();
    return { ...item };
  }

  async markCalendar(id, status, error = null) {
    Object.assign(this.find(id), { calendarStatus: status, calendarError: error, calendarUpdatedAt: new Date().toISOString() });
    await this.save();
  }

  start() {
    if (this.timer) return;
    const run = () => this.deliverDue().catch((error) => this.onEvent({ type: "qq-reminder-error", error: error.message, at: new Date().toISOString() }));
    this.timer = setInterval(run, 30_000);
    this.timer.unref();
    run();
  }

  async deliverDue(now = Date.now()) {
    if (this.running || !this.ownerId) return;
    this.running = true;
    try {
      for (const item of this.items) {
        if (item.status !== "pending" || Date.parse(item.reminderAt) > now) continue;
        item.status = "sending";
        await this.save();
        const when = item.start ? new Date(item.start).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "";
        try {
          const result = await this.oneBot.sendPrivateMessage(this.ownerId, `日程提醒：${item.title}${when ? `\n开始时间：${when}` : ""}`);
          if (!result?.ok) throw new Error(`QQ 提醒发送失败（HTTP ${result?.status || "unknown"}）`);
        } catch (error) {
          item.status = "pending";
          item.lastError = error.message;
          this.lastError = error.message;
          await this.save();
          throw error;
        }
        item.status = "sent";
        item.lastError = null;
        this.lastError = null;
        item.sentAt = new Date().toISOString();
        await this.save();
        this.onEvent({ type: "qq-reminder-sent", actionId: item.actionId, at: item.sentAt });
      }
    } finally {
      this.running = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  save() {
    const contents = `${JSON.stringify(this.items, null, 2)}\n`;
    const pending = this.saveQueue.catch(() => {}).then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      await writeFile(temporaryPath, contents, { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    this.saveQueue = pending;
    return pending;
  }
}

// ponytail: exact normalized title/time/place deduplication; paraphrases need a separate review step.
function duplicateKey(action) {
  const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return JSON.stringify([normalize(action.title), new Date(action.start || action.reminderAt).toISOString(), normalize(action.location)]);
}

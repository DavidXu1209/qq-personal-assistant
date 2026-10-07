import { parsePersonalTurn } from "./personal-turn.js";

export function isPersonalCommand(message) {
  return message?.trust === "OWNER" && !message.replyToMessageId && !(message.attachments || []).length
    && /^\/?(?:查看提醒|提醒|取消提醒|修改提醒|状态|机器人状态)(?:\s|$)/.test(String(message.text || "").trim());
}

const formatTime = value => new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
const help = "查看提醒（或 查看提醒 全部）\n取消提醒 编号\n修改提醒 编号 2026-10-09 14:00\n状态";

export async function syncPersonalCalendar(action, scheduler, calendar, remove = false) {
  try {
    if (!calendar) throw new Error("iCloud 日历未连接");
    if (remove) await calendar.remove(action); else await calendar.execute(action);
    await scheduler.markCalendar?.(action.actionId, remove ? "deleted" : "synced");
    return remove ? "iCloud 日程已删除。" : "已同步 iCloud「QQ提醒」日历。";
  } catch (error) {
    await scheduler.markCalendar?.(action.actionId, "failed", error.message);
    return `iCloud ${remove ? "删除" : "写入"}失败：${error.message}；QQ 提醒的本地操作已完成。`;
  }
}

export async function handlePersonalCommand(message, { scheduler, calendar, status = async () => "状态查询暂不可用" } = {}) {
  if (!isPersonalCommand(message)) return null;
  const text = String(message.text).trim().replace(/^\//, "");
  if (["状态", "机器人状态"].includes(text)) return status();
  if (!scheduler) return "提醒队列暂不可用。";
  if (/^(?:查看提醒|提醒)(?: 全部)?$/.test(text)) {
    const items = scheduler.list(text.endsWith("全部"));
    if (!items.length) return "当前没有提醒。\n" + help;
    const labels = { pending: "待提醒", sending: "发送中", sent: "已提醒", cancelled: "已取消" };
    const rows = items.slice(0, 50).map(item => `${item.actionId.slice(0, 8)}｜${item.title}｜${formatTime(item.start || item.reminderAt)}｜${labels[item.status] || item.status}${item.calendarStatus === "failed" ? "｜日历未同步" : ""}`);
    return rows.join("\n") + (items.length > 50 ? `\n只显示前50条，共${items.length}条。` : "") + "\n\n" + help;
  }
  const cancel = /^取消提醒\s+([a-f\d]{8,24})$/i.exec(text);
  const update = /^修改提醒\s+([a-f\d]{8,24})\s+(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/i.exec(text);
  try {
    if (cancel) {
      const action = await scheduler.cancel(cancel[1]);
      const calendarResult = await syncPersonalCalendar(action, scheduler, calendar, true);
      return `已取消 QQ 提醒：${action.title}。\n${calendarResult}`;
    }
    if (update) {
      const current = scheduler.find(update[1]);
      const wasCancelled = current.status === "cancelled";
      const when = update[2] + (update[3] ? `T${update[3]}+08:00` : "");
      const action = parsePersonalTurn(JSON.stringify({ reply: "修改提醒", actions: [{ type: current.type || "calendar", title: current.title, when, end: null, location: current.location || "", notes: current.notes || "" }] })).actions[0];
      if (Date.parse(action.start) <= Date.now()) throw new Error("新日程时间已经过去，请重新确认日期和时刻");
      const duration = Date.parse(current.end) - Date.parse(current.start);
      if (Number.isFinite(duration) && duration > 0) action.end = new Date(Date.parse(action.start) + duration).toISOString();
      const saved = await scheduler.update(update[1], action);
      return `已修改${wasCancelled ? "并重新启用" : ""} QQ 提醒：${saved.title}；日程 ${formatTime(saved.start)}，提醒 ${formatTime(saved.reminderAt)}。\n${await syncPersonalCalendar(saved, scheduler, calendar)}`;
    }
    return "命令格式不正确，请使用：\n" + help;
  } catch (error) { return `操作未完成：${error.message}。`; }
}

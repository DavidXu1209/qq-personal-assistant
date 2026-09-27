"use strict";

const CALENDAR_NAMES = ["学习", "社团", "活动"];
const REMINDER_LIST_NAME = "待办";

function safe(callable, fallback) {
  try { return callable(); } catch (_) { return fallback; }
}

function exactNamed(items, name) {
  for (const item of items) {
    if (String(safe(() => item.name(), "")) === name) return item;
  }
  return null;
}

function findByMarker(items, marker, noteGetter) {
  const matches = [];
  for (const item of items) {
    const note = String(safe(() => noteGetter(item), ""));
    if (note.includes(marker)) matches.push(item);
  }
  return matches;
}

function findCalendarByTitleAndMarker(calendar, title, marker) {
  const matches = [];
  const items = safe(() => calendar.events.whose({ summary: title })(), []);
  for (const item of items) {
    const note = String(safe(() => item.description(), ""));
    if (note.includes(marker)) matches.push(item);
  }
  return matches;
}

function updateCalendarEvent(event, payload, start, end, description) {
  const oldStart = safe(() => event.startDate(), start);
  if (end <= oldStart) {
    event.startDate = start;
    event.endDate = end;
  } else {
    event.endDate = end;
    event.startDate = start;
  }
  event.summary = payload.title;
  event.location = payload.location || "";
  event.description = description;
  event.alldayEvent = Boolean(payload.allDay);
}

function upsertCalendar(payload, provenance) {
  if (!CALENDAR_NAMES.includes(payload.calendarName)) throw new Error("日历只能选择：学习、社团、活动");
  const app = Application("Calendar");
  const calendar = exactNamed(safe(() => app.calendars(), []), payload.calendarName);
  if (!calendar) throw new Error(`找不到日历“${payload.calendarName}”`);
  if (!safe(() => calendar.writable(), false)) throw new Error(`日历“${payload.calendarName}”不可写`);

  const matches = findCalendarByTitleAndMarker(calendar, payload.title, payload.marker);
  if (matches.length > 1) throw new Error(`日历“${payload.calendarName}”中存在重复的网关事项`);
  const start = new Date(payload.start);
  const end = payload.end ? new Date(payload.end) : new Date(payload.start);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new Error("日历事项时间无效");
  const description = [payload.notes || "", provenance].filter(Boolean).join("\n\n");
  let event = matches[0] || null;
  if (!event) {
    event = app.Event({
      summary: payload.title,
      startDate: start,
      endDate: end,
      location: payload.location || "",
      description,
      alldayEvent: Boolean(payload.allDay)
    });
    calendar.events.push(event);
  } else {
    updateCalendarEvent(event, payload, start, end, description);
  }

  const verified = findCalendarByTitleAndMarker(calendar, payload.title, payload.marker);
  if (verified.length !== 1) throw new Error(`日历“${payload.calendarName}”写入后校验失败`);
  return {
    externalItemId: safe(() => verified[0].uid(), null),
    result: `已写入或更新“${payload.calendarName}”日历`,
    targetList: payload.calendarName
  };
}

function upsertReminder(payload, provenance) {
  const app = Application("Reminders");
  const list = exactNamed(safe(() => app.lists(), []), REMINDER_LIST_NAME);
  if (!list) throw new Error(`找不到提醒事项列表“${REMINDER_LIST_NAME}”`);

  const matches = findByMarker(safe(() => list.reminders(), []), payload.marker, (item) => item.body());
  if (matches.length > 1) throw new Error(`提醒事项列表“${REMINDER_LIST_NAME}”中存在重复的网关事项`);
  const body = [payload.notes || "", provenance].filter(Boolean).join("\n\n");
  let reminder = matches[0] || null;
  if (!reminder) {
    const properties = { name: payload.title, body };
    if (payload.due) properties.dueDate = new Date(payload.due);
    reminder = app.Reminder(properties);
    list.reminders.push(reminder);
  } else {
    reminder.name = payload.title;
    reminder.body = body;
    if (payload.due) reminder.dueDate = new Date(payload.due);
  }

  const verified = findByMarker(safe(() => list.reminders(), []), payload.marker, (item) => item.body());
  if (verified.length !== 1) throw new Error(`提醒事项列表“${REMINDER_LIST_NAME}”写入后校验失败`);
  return {
    externalItemId: safe(() => verified[0].id(), null),
    result: `已写入或更新“${REMINDER_LIST_NAME}”待办列表`,
    targetList: REMINDER_LIST_NAME
  };
}

function preflight() {
  const calendarApp = Application("Calendar");
  const calendars = safe(() => calendarApp.calendars(), []);
  const calendarStatus = {};
  for (const name of CALENDAR_NAMES) {
    const calendar = exactNamed(calendars, name);
    calendarStatus[name] = Boolean(calendar && safe(() => calendar.writable(), false));
  }
  const remindersApp = Application("Reminders");
  const reminderList = exactNamed(safe(() => remindersApp.lists(), []), REMINDER_LIST_NAME);
  const ready = Object.values(calendarStatus).every(Boolean) && Boolean(reminderList);
  if (!ready) throw new Error("目标日历或待办列表缺失或不可写");
  return { ready, calendars: calendarStatus, reminderList: REMINDER_LIST_NAME };
}

function run(argv) {
  const payload = JSON.parse(argv[0]);
  if (payload.type === "preflight") return JSON.stringify(preflight());
  if (!payload.title || !payload.marker) throw new Error("通知动作缺少标题或幂等标记");
  const provenance = `${payload.marker}\n来源群：${payload.sourceGroupName} (${payload.sourceGroupId})`;
  if (payload.type === "calendar") return JSON.stringify(upsertCalendar(payload, provenance));
  if (payload.type === "reminder") return JSON.stringify(upsertReminder(payload, provenance));
  throw new Error("不支持的通知自动化类型");
}

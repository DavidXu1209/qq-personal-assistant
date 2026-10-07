import { randomUUID } from "node:crypto";

const ICLOUD_CALDAV = "https://caldav.icloud.com/";
const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";

export class ICloudCalDavClient {
  constructor({ username = "", password = "", calendarName = "QQ提醒", fetchImpl = fetch } = {}) {
    this.username = String(username || "").trim();
    this.password = String(password || "").trim();
    this.calendarName = String(calendarName || "QQ提醒").trim();
    this.fetchImpl = fetchImpl;
    this.homeUrl = null;
    this.calendarUrl = null;
  }

  async execute(action) {
    this.requireCredentials();
    const start = validDate(action.start || action.due);
    if (!start) throw new Error("日历事项缺少有效的开始时间");
    const end = validDate(action.end) || new Date(start.getTime() + 30 * 60_000);
    if (end <= start) throw new Error("日历结束时间必须晚于开始时间");
    const reminderAt = validDate(action.reminderAt) || start;
    await this.ensureCalendar(true);
    const uid = `${String(action.actionId || randomUUID()).replace(/[^a-z0-9-]/gi, "") || randomUUID()}@qq-reminder.local`;
    const body = eventCalendar({ ...action, start, end, reminderAt, uid });
    const url = new URL(`${encodeURIComponent(uid)}.ics`, this.calendarUrl);
    const response = await this.request(url, "PUT", body, { "content-type": "text/calendar; charset=utf-8" });
    if (![200, 201, 204].includes(response.status)) throw new Error(`iCloud 日历写入失败（HTTP ${response.status}）`);
    return { externalItemId: uid, result: "已写入 iCloud 日历", targetList: this.calendarName };
  }

  requireCredentials() {
    if (!this.username || !this.password) throw new Error("请在 Windows 凭据文件中配置 Apple 账号和 iCloud 专用密码");
  }

  async remove(action) {
    this.requireCredentials();
    await this.ensureCalendar(false);
    if (!this.calendarUrl) throw new Error("找不到 QQ提醒 日历，无法确认日程是否已删除");
    const uid = `${String(action.actionId).replace(/[^a-z0-9-]/gi, "")}@qq-reminder.local`;
    const response = await this.request(new URL(`${encodeURIComponent(uid)}.ics`, this.calendarUrl), "DELETE");
    if (![200, 204, 404, 410].includes(response.status)) throw new Error(`iCloud 日程删除失败（HTTP ${response.status}）`);
  }

  async ensureCalendar(createIfMissing) {
    if (this.calendarUrl) return;
    if (!this.homeUrl) {
      const principal = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV_NS}"><d:prop><d:current-user-principal/></d:prop></d:propfind>`;
      const root = await this.request(ICLOUD_CALDAV, "PROPFIND", principal, { Depth: "0", "content-type": "application/xml; charset=utf-8" });
      if (root.status !== 207) throw new Error(`iCloud CalDAV 登录/发现失败（HTTP ${root.status}）`);
      const principalHref = propertyHref(root.body, "current-user-principal");
      if (!principalHref) throw new Error("iCloud CalDAV 未返回用户日历入口");
      const principalUrl = new URL(principalHref, root.url);
      const homeBody = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`;
      const principalResponse = await this.request(principalUrl, "PROPFIND", homeBody, { Depth: "0", "content-type": "application/xml; charset=utf-8" });
      if (principalResponse.status !== 207) throw new Error(`iCloud 日历入口读取失败（HTTP ${principalResponse.status}）`);
      const homeHref = propertyHref(principalResponse.body, "calendar-home-set");
      if (!homeHref) throw new Error("iCloud CalDAV 未返回日历集合入口");
      this.homeUrl = new URL(homeHref, principalResponse.url);
    }
    const propfind = `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="${DAV_NS}"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`;
    const response = await this.request(this.homeUrl, "PROPFIND", propfind, { Depth: "1", "content-type": "application/xml; charset=utf-8" });
    if (response.status !== 207) throw new Error(`iCloud 日历列表读取失败（HTTP ${response.status}）`);
    const calendars = responseBlocks(response.body).filter((block) => /<(?:[\w.-]+:)?calendar\b/i.test(block));
    const selected = calendars.find((block) => decodeXml(elementText(block, "displayname")) === this.calendarName);
    const href = selected && elementText(selected, "href");
    if (href) {
      this.calendarUrl = new URL(decodeXml(href), response.url);
      return;
    }
    if (!createIfMissing) return;
    const collectionUrl = new URL(`${randomUUID()}/`, this.homeUrl);
    const createBody = `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="${DAV_NS}" xmlns:c="${CALDAV_NS}"><d:set><d:prop><d:displayname>${xmlEscape(this.calendarName)}</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
    const created = await this.request(collectionUrl, "MKCALENDAR", createBody, { "content-type": "application/xml; charset=utf-8" });
    if (![200, 201, 204].includes(created.status) && created.status !== 405 && created.status !== 409) {
      throw new Error(`创建 iCloud「${this.calendarName}」日历失败（HTTP ${created.status}）`);
    }
    this.calendarUrl = collectionUrl;
    if (created.status === 405 || created.status === 409) {
      this.calendarUrl = null;
      const refreshed = await this.request(this.homeUrl, "PROPFIND", propfind, { Depth: "1", "content-type": "application/xml; charset=utf-8" });
      const existing = responseBlocks(refreshed.body).find((block) => /<(?:[\w.-]+:)?calendar\b/i.test(block)
        && decodeXml(elementText(block, "displayname")) === this.calendarName);
      if (!existing) throw new Error(`iCloud「${this.calendarName}」日历已存在，但读取不到该日历`);
      this.calendarUrl = new URL(decodeXml(elementText(existing, "href")), refreshed.url);
    }
  }

  async request(input, method, body = "", headers = {}) {
    let url = new URL(input);
    if (!isICloudUrl(url)) throw new Error("拒绝向非 iCloud HTTPS 地址发送日历凭据");
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await this.fetchImpl(url, {
        method, redirect: "manual", body: body || undefined,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`,
          ...headers
        },
        signal: AbortSignal.timeout(20_000)
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return { status: response.status, body: await response.text(), url };
      }
      const location = response.headers.get("location");
      if (!location) throw new Error("iCloud CalDAV 重定向缺少目标地址");
      const next = new URL(location, url);
      if (!isICloudUrl(next)) throw new Error("拒绝将 iCloud 日历凭据转发到外部地址");
      url = next;
    }
    throw new Error("iCloud CalDAV 重定向次数过多");
  }
}

function isICloudUrl(url) {
  return url.protocol === "https:" && !url.username && !url.password && !url.port
    && /(^|\.)icloud\.com(?:\.cn)?$/i.test(url.hostname);
}

function eventCalendar(action) {
  const start = icalUtc(action.start);
  const end = icalUtc(action.end);
  const alarmMinutes = Math.max(0, Math.round((action.start.getTime() - action.reminderAt.getTime()) / 60_000));
  const alarmTrigger = alarmMinutes ? `-PT${alarmMinutes}M` : "PT0M";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//QQ Reminder//iCloud Calendar//ZH-CN", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${action.uid}`, `DTSTAMP:${icalUtc(new Date())}`, `DTSTART:${start}`, `DTEND:${end}`,
    `SUMMARY:${icalEscape(action.title)}`
  ];
  if (action.location) lines.push(`LOCATION:${icalEscape(action.location)}`);
  if (action.notes) lines.push(`DESCRIPTION:${icalEscape(action.notes)}`);
  lines.push("BEGIN:VALARM", `TRIGGER:${alarmTrigger}`, "ACTION:DISPLAY", `DESCRIPTION:${icalEscape(action.title)}`, "END:VALARM", "END:VEVENT", "END:VCALENDAR", "");
  return lines.map(foldLine).join("\r\n");
}

// RFC 5545 section 3.1: fold at 75 octets without splitting a UTF-8 character.
function foldLine(text) {
  let output = "", length = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    if (length + bytes > 75) { output += "\r\n "; length = 1; }
    output += character;
    length += bytes;
  }
  return output;
}

function validDate(value) {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}
function icalUtc(value) { return validDate(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); }
function icalEscape(value) { return String(value || "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;"); }
function xmlEscape(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function decodeXml(value) {
  return String(value || "").replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (match) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[match.toLowerCase()]) return named[match.toLowerCase()];
    const hex = /^&#x([\da-f]+);$/i.exec(match);
    const decimal = /^&#(\d+);$/.exec(match);
    const point = hex ? Number.parseInt(hex[1], 16) : Number(decimal?.[1]);
    return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}
function tag(name) { return `(?:[\\w.-]+:)?${name}`; }
function elementText(xml, name) {
  const re = new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)<\\/${tag(name)}\\s*>`, "i");
  return re.exec(String(xml || ""))?.[1]?.trim() || "";
}
function xmlElements(xml, name) {
  const re = new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)<\\/${tag(name)}\\s*>`, "gi");
  return [...String(xml || "").matchAll(re)].map((match) => match[1]);
}
function propertyHref(xml, name) {
  const re = new RegExp(`<${tag(name)}\\b[^>]*>([\\s\\S]*?)<\\/${tag(name)}\\s*>`, "i");
  const property = re.exec(String(xml || ""))?.[1];
  return property ? decodeXml(elementText(property, "href")) : "";
}
function responseBlocks(xml) { return xmlElements(xml, "response"); }

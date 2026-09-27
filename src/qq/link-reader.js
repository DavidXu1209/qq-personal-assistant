import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 16_000;
const dnsCache = new Map();

export function extractUrls(text) {
  const found = String(text || "").match(/https?:\/\/[^\s<>"'`\u0000-\u001f，。；！？、【】（）]+/giu) || [];
  return [...new Set(found.map((value) => value.replace(/[，。；！？、）】\]\)]+$/u, ""))
    .map((value) => { try { return new URL(value).href; } catch { return null; } }).filter(Boolean))].slice(0, 40);
}

export function isPublicAddress(value) {
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 28 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && [18, 19].includes(b)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(value) === 6) {
    // Allow native global unicast only, not local/mapped/transition networks.
    const first = Number.parseInt(value.split(":")[0], 16);
    if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff || first === 0x2002) return false;
    if (/^2001:(?:0*:|0*db8:|0*2:|0*10:|0*20:)/i.test(value)) return false;
    return true;
  }
  return false;
}

export async function validatePublicUrl(value, lookupImpl = lookup) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || (url.port && !["80", "443"].includes(url.port))) throw new Error("只允许不含凭据的公开 HTTP/HTTPS 链接及标准端口");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || /\.(?:localhost|local|internal|lan)$/i.test(hostname)) throw new Error("不能打开本机或内网链接");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupImpl(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("链接指向本机、内网或非公开地址，已拒绝");
  return { url, addresses };
}

// DNS is resolved and verified before the request, then pinned in lookup.
// No cookies, OneBot credentials or host login state are sent to the website.
export async function requestPage({ url, addresses }, { signal, maxBytes = MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET", signal,
      headers: { "user-agent": "QQ-Agent-LinkReader/1.0", accept: "text/html,text/plain,application/json", "accept-encoding": "identity" },
      lookup: (_hostname, options, callback) => {
        const matching = addresses.filter((item) => !options.family || item.family === options.family);
        const selected = matching.length ? matching : addresses;
        if (options.all) callback(null, selected);
        else callback(null, selected[0].address, selected[0].family);
      }
    }, async (response) => {
      // Attach before any early rejection so destroying the response is safe.
      response.on("error", reject);
      try {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy(); resolve({ status, headers: response.headers, bytes: Buffer.alloc(0) }); return;
        }
        const type = String(response.headers["content-type"] || "").toLowerCase();
        if (status < 200 || status >= 300) throw new Error(`网页返回 HTTP ${status}`);
        if (!/^(?:text\/(?:html|plain)|application\/(?:json|xhtml\+xml))(?:;|$)/.test(type)) {
          throw new Error("链接不是可读取的文字网页；不会自动下载文件或执行内容");
        }
        if (Number(response.headers["content-length"] || 0) > maxBytes) {
          throw new Error("网页传输内容超过读取上限");
        }
        const decoders = { gzip: createGunzip, "x-gzip": createGunzip, deflate: createInflate, br: createBrotliDecompress };
        const encodings = String(response.headers["content-encoding"] || "identity").toLowerCase().split(",").map((item) => item.trim());
        if (encodings.length > 3 || encodings.some((item) => item !== "identity" && !Object.hasOwn(decoders, item))) {
          throw new Error("网页返回未支持的压缩内容");
        }
        const limit = (label) => {
          let size = 0;
          return new Transform({ transform(chunk, _encoding, callback) {
            size += chunk.length;
            callback(size > maxBytes ? new Error(`网页${label}超过读取上限`) : null, chunk);
          } });
        };
        // Bound both wire bytes and every decoded layer; never inflate an
        // unbounded buffer first. The same request deadline covers decompression.
        const streams = [response, limit("传输内容")];
        for (const encoding of encodings.reverse()) if (encoding !== "identity") streams.push(decoders[encoding](), limit("解压内容"));
        const chunks = [];
        streams.push(new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } }));
        await pipeline(streams, { signal });
        resolve({ status, headers: response.headers, bytes: Buffer.concat(chunks) });
      } catch (error) {
        response.destroy(); request.destroy(); reject(error);
      }
    });
    request.on("error", reject);
    request.end();
  });
}

// Resolve public domains independently of a local proxy's synthetic addresses.
// Only the hostname is sent, never the chat text, path, query or credentials.
// API: https://developers.google.com/speed/public-dns/docs/doh/json
export async function resolvePublicDns(hostname, { signal = AbortSignal.timeout(5000) } = {}) {
  const cached = dnsCache.get(hostname);
  if (cached?.expiresAt > Date.now()) return cached.addresses;
  let addresses = [];
  let ttl = 60;
  for (const type of ["A", "AAAA"]) {
    const url = new URL("https://dns.google/resolve");
    url.search = new URLSearchParams({ name: hostname, type, edns_client_subnet: "0.0.0.0/0" }).toString();
    const response = await requestPage({ url, addresses: [{ address: "8.8.8.8", family: 4 }] }, { signal, maxBytes: 64_000 });
    if (response.status !== 200) throw new Error("公开域名解析未成功");
    const result = JSON.parse(response.bytes.toString("utf8"));
    if (result.Status !== 0) throw new Error("公开域名解析失败，不能使用本机代理地址绕过安全检查");
    const records = (result.Answer || []).filter((item) => item.type === (type === "A" ? 1 : 28));
    addresses = records.map((item) => ({ address: String(item.data), family: type === "A" ? 4 : 6 }));
    for (const item of records) ttl = Math.min(ttl, Number(item.TTL || 5));
    if (addresses.length) break;
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error("公开 DNS 返回非公开地址，已拒绝");
  if (dnsCache.size >= 100) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(hostname, { addresses, expiresAt: Date.now() + Math.max(1, ttl) * 1000 });
  return addresses;
}

export function decodeHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
    if (!code.startsWith("#")) return named[code.toLowerCase()] || match;
    const number = code[1].toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return Number.isInteger(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

export function extractPage(bytes, type, url) {
  const charset = /charset\s*=\s*["']?([\w-]+)/i.exec(type)?.[1] || "utf-8";
  let html;
  try { html = new TextDecoder(charset).decode(bytes); } catch { html = bytes.toString("utf8"); }
  const isHtml = /html/i.test(type);
  const title = isHtml ? decodeHtmlEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").trim().slice(0, 300) : "";
  const links = [];
  if (isHtml) {
    for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
      try { const href = new URL(decodeHtmlEntities(match[1]), url); if (["http:", "https:"].includes(href.protocol)) links.push(href.href); } catch { /* invalid href */ }
      if (links.length >= 30) break;
    }
  }
  const text = (isHtml ? decodeHtmlEntities(html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(?:p|div|br|li|h[1-6]|section|article|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")) : html)
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, links: [...new Set([...links, ...extractUrls(text)])].slice(0, 30) };
}

export class PublicLinkReader {
  constructor({ lookupImpl = resolvePublicDns, requestImpl = requestPage, timeoutMs = 10_000 } = {}) {
    this.lookupImpl = lookupImpl; this.requestImpl = requestImpl; this.timeoutMs = timeoutMs;
  }
  async read(value) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let current = new URL(value).href;
    for (let redirects = 0; redirects <= 4; redirects++) {
      if (signal.aborted) throw new Error("网页读取超时");
      const verified = await validatePublicUrl(current, (hostname, options) => this.lookupImpl(hostname, { ...options, signal }));
      const result = await this.requestImpl(verified, { signal, maxBytes: MAX_BYTES });
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.headers.location || redirects === 4) throw new Error("网页重定向次数过多或缺少目标");
        current = new URL(result.headers.location, current).href;
        continue;
      }
      const page = extractPage(result.bytes, String(result.headers["content-type"] || "text/plain"), current);
      return { url: current, trust: "UNTRUSTED_WEB", ...page, note: "仅获取公开网页文字，不执行脚本或使用登录态；视频页的标题、简介不代表已观看画面或听取音频。登录墙、验证码或动态页面可能无法完整读取。" };
    }
  }
}

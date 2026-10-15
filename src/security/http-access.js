import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const STICKER_IMAGE_PATH = /^\/api\/qq\/stickers\/st_[a-f0-9]{12,64}\/image$/iu;
const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const MIN_GRANT_TTL_MS = 60 * 1000;
const MAX_GRANT_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_GRANTS = 32;
const BROWSER_GRANT_ALLOW = ["GET /api/qq/stream", "GET /api/qq/stickers/*/image"];

// EventSource and <img> cannot attach Authorization. The bundled console
// exchanges the long-lived hub token for one of these grants and puts only
// the grant in the URL. Grants expire quickly and cannot call other routes.
export function browserGrantAllows(method, pathname) {
  if (String(method || "").toUpperCase() !== "GET") return false;
  const path = String(pathname || "");
  return path === "/api/qq/stream" || STICKER_IMAGE_PATH.test(path);
}

export function createHttpAccess({
  apiToken = "",
  oneBotTokens = [],
  host = "127.0.0.1",
  port = 3789,
  extraOrigins = "",
  allowFileOrigin = true,
  grantTtlMs = DEFAULT_GRANT_TTL_MS,
  maxActiveGrants = MAX_ACTIVE_GRANTS,
  now = Date.now,
  randomBytes: randomBytesImpl = randomBytes
} = {}) {
  const longLivedToken = String(apiToken || "");
  const callbackTokens = [...new Set(oneBotTokens.map((value) => String(value || "").trim()).filter(Boolean))];
  const ttlMs = clampGrantTtl(grantTtlMs);
  const allowedOrigins = new Set(defaultConsoleOrigins(host, port));
  for (const origin of parseOriginList(extraOrigins)) allowedOrigins.add(origin);
  const fileOriginAllowed = parseFlag(allowFileOrigin, true);
  if (fileOriginAllowed) {
    allowedOrigins.add("null");
    allowedOrigins.add("file://");
  }
  const grants = new BrowserGrants({ ttlMs, now, randomBytes: randomBytesImpl, maxActive: maxActiveGrants });

  return {
    grantTtlMs: ttlMs,
    allowedOrigins: () => [...allowedOrigins],
    issueBrowserGrant({ headers = {} } = {}) {
      const origin = normalizeOrigin(headers.origin);
      return grants.issue(origin);
    },
    authorize({ method = "GET", path = "", headers = {}, searchParams = null, signatureOk = false } = {}) {
      const upperMethod = String(method || "GET").toUpperCase();
      const origin = normalizeOrigin(headers.origin);
      const { bearer, named } = headerCredentials(headers);
      const query = queryCredential(searchParams);

      if (path === "/api/onebot/event") {
        if (signatureOk) return true;
        return [bearer, named, query].some((candidate) => callbackTokens.some((expected) => tokenEquals(candidate, expected)));
      }
      if (!longLivedToken) return true;
      if (tokenEquals(bearer, longLivedToken) || tokenEquals(named, longLivedToken)) return true;
      if (!query || tokenEquals(query, longLivedToken)) return false;
      if (origin && !allowedOrigins.has(origin)) return false;
      return grants.verify(query, { method: upperMethod, pathname: path, origin });
    },
    corsHeaders(request) {
      const headers = {
        "access-control-allow-headers": "authorization, content-type, x-codex-remote-token, x-signature",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "600",
        vary: "Origin",
        "referrer-policy": "no-referrer"
      };
      const origin = normalizeOrigin(request?.headers?.origin);
      if (origin && allowedOrigins.has(origin)) headers["access-control-allow-origin"] = origin;
      return headers;
    }
  };
}

function BrowserGrants({ ttlMs, now, randomBytes: randomBytesImpl, maxActive }) {
  const records = new Map();
  let order = [];

  function prune() {
    const current = now();
    order = order.filter((id) => {
      const record = records.get(id);
      if (!record || record.expiresAt <= current) {
        records.delete(id);
        return false;
      }
      return true;
    });
  }

  return {
    issue(origin) {
      prune();
      const token = randomBytesImpl(32).toString("base64url");
      const id = digest(token);
      const expiresAt = now() + ttlMs;
      records.set(id, { expiresAt, origin: origin || "" });
      order.push(id);
      while (order.length > maxActive) records.delete(order.shift());
      return {
        accessToken: token,
        expiresAt: new Date(expiresAt).toISOString(),
        expiresInMs: ttlMs,
        tokenType: "browser-grant",
        allow: BROWSER_GRANT_ALLOW
      };
    },
    verify(token, { method, pathname, origin }) {
      if (!browserGrantAllows(method, pathname)) return false;
      prune();
      const record = records.get(digest(token));
      if (!record) return false;
      if (record.origin && origin && record.origin !== origin) return false;
      return true;
    }
  };
}

function headerCredentials(headers) {
  const authorization = String(headers.authorization || headers.Authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim() || "";
  const named = String(headers["x-codex-remote-token"] || "").trim();
  return { bearer, named };
}

function queryCredential(searchParams) {
  if (!searchParams) return "";
  const value = typeof searchParams.get === "function" ? searchParams.get("access_token") : searchParams.access_token;
  return String(value || "").trim();
}

function tokenEquals(candidate, expected) {
  const left = Buffer.from(String(candidate || ""));
  const right = Buffer.from(String(expected || ""));
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function digest(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function clampGrantTtl(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GRANT_TTL_MS;
  return Math.min(MAX_GRANT_TTL_MS, Math.max(MIN_GRANT_TTL_MS, Math.floor(parsed)));
}

function parseFlag(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

function parseOriginList(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  const origins = [];
  for (const entry of entries) {
    const origin = normalizeOrigin(entry);
    if (origin) origins.push(origin);
  }
  return origins;
}

export function normalizeOrigin(value) {
  const text = String(value || "").trim();
  if (!text || text === "*") return "";
  if (text === "null" || text === "file://") return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

function defaultConsoleOrigins(host, port) {
  const suffix = `:${String(port || "").trim()}`;
  const origins = ["127.0.0.1", "localhost", "[::1]"].map((name) => `http://${name}${suffix}`);
  const formatted = formatBindHost(host);
  if (formatted && !["127.0.0.1", "localhost", "[::1]"].includes(formatted)) {
    origins.push(`http://${formatted}${suffix}`);
  }
  return origins;
}

function formatBindHost(host) {
  const raw = String(host || "").trim().replace(/^\[|\]$/gu, "");
  if (!raw || raw === "0.0.0.0" || raw === "::" || raw === "*") return "";
  return raw.includes(":") ? `[${raw}]` : raw;
}

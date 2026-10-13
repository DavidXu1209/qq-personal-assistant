import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHttpAccess } from "../src/security/http-access.js";

const API_TOKEN = "synthetic-hub-token";
const ONEBOT_TOKEN = "synthetic-onebot-token";
const STICKER_IMAGE = "/api/qq/stickers/st_0123456789ab/image";

function clock(start = 1_700_000_000_000) {
  let current = start;
  return { now: () => current, advance(ms) { current += ms; } };
}

function tokens() {
  let n = 0;
  return () => {
    n += 1;
    const buffer = Buffer.alloc(32, n);
    buffer[0] = n;
    return buffer;
  };
}

function access(overrides = {}, time = clock()) {
  return {
    time,
    http: createHttpAccess({
      apiToken: API_TOKEN,
      oneBotTokens: [ONEBOT_TOKEN, API_TOKEN],
      host: "127.0.0.1",
      port: 3789,
      now: time.now,
      randomBytes: tokens(),
      ...overrides
    })
  };
}

function query(token) {
  return new URLSearchParams({ access_token: token });
}

test("management calls accept the long-lived token only from request headers", () => {
  const { http } = access();
  assert.equal(http.authorize({ method: "GET", path: "/api/state", headers: { authorization: `Bearer ${API_TOKEN}` } }), true);
  assert.equal(http.authorize({ method: "POST", path: "/api/qq/agent-dispatch", headers: { "x-codex-remote-token": API_TOKEN } }), true);
  assert.equal(http.authorize({ method: "GET", path: "/api/state", headers: { authorization: "Bearer wrong-token" } }), false);
  assert.equal(http.authorize({ method: "GET", path: "/api/state" }), false);
  for (const path of ["/api/state", "/api/qq/stream", STICKER_IMAGE, "/api/personal/status"]) {
    assert.equal(http.authorize({ method: "GET", path, searchParams: query(API_TOKEN) }), false, path);
  }
});

test("header credentials still authorize when a query token is also present", () => {
  const { http } = access();
  assert.equal(http.authorize({
    method: "GET",
    path: "/api/state",
    headers: { authorization: `Bearer ${API_TOKEN}` },
    searchParams: query(API_TOKEN)
  }), true);
});

test("browser grants authorize only the console stream and sticker images until they expire", () => {
  const { http, time } = access();
  const issued = http.issueBrowserGrant({ headers: { origin: "http://127.0.0.1:3789" } });
  assert.notEqual(issued.accessToken, API_TOKEN);
  assert.equal(issued.tokenType, "browser-grant");
  assert.deepEqual(issued.allow, ["GET /api/qq/stream", "GET /api/qq/stickers/*/image"]);
  const headers = { origin: "http://127.0.0.1:3789" };
  const params = query(issued.accessToken);
  assert.equal(http.authorize({ method: "GET", path: "/api/qq/stream", headers, searchParams: params }), true);
  assert.equal(http.authorize({ method: "GET", path: STICKER_IMAGE, headers, searchParams: params }), true);
  assert.equal(http.authorize({ method: "GET", path: "/api/state", headers, searchParams: params }), false);
  assert.equal(http.authorize({ method: "POST", path: "/api/qq/stream", headers, searchParams: params }), false);
  assert.equal(http.authorize({ method: "POST", path: "/api/auth/browser-grant", headers, searchParams: params }), false);
  assert.equal(http.authorize({ method: "GET", path: "/api/qq/stickers/st_short/image", headers, searchParams: params }), false);
  assert.equal(http.authorize({
    method: "GET",
    path: "/api/qq/stream",
    headers: { authorization: `Bearer ${issued.accessToken}` }
  }), false);
  assert.equal(http.authorize({
    method: "GET",
    path: "/api/qq/stream",
    headers: { origin: "http://localhost:3789" },
    searchParams: params
  }), false);
  time.advance(http.grantTtlMs + 1);
  assert.equal(http.authorize({ method: "GET", path: "/api/qq/stream", headers, searchParams: params }), false);
});

test("a browser grant is refused to a page outside the console allowlist", () => {
  const { http } = access();
  const issued = http.issueBrowserGrant({ headers: {} });
  assert.equal(http.authorize({
    method: "GET",
    path: "/api/qq/stream",
    headers: { origin: "https://evil.example" },
    searchParams: query(issued.accessToken)
  }), false);
  assert.equal(http.authorize({
    method: "GET",
    path: "/api/qq/stream",
    searchParams: query(issued.accessToken)
  }), true);
});

test("OneBot callbacks keep header, query, and signature authentication", () => {
  const { http } = access();
  const path = "/api/onebot/event";
  assert.equal(http.authorize({ method: "POST", path, headers: { authorization: `Bearer ${ONEBOT_TOKEN}` } }), true);
  assert.equal(http.authorize({ method: "POST", path, headers: { "x-codex-remote-token": API_TOKEN } }), true);
  assert.equal(http.authorize({ method: "POST", path, searchParams: query(ONEBOT_TOKEN) }), true);
  assert.equal(http.authorize({ method: "POST", path, searchParams: query(API_TOKEN) }), true);
  assert.equal(http.authorize({ method: "POST", path, signatureOk: true }), true);
  assert.equal(http.authorize({ method: "POST", path, searchParams: query("nope") }), false);
  const open = createHttpAccess({ apiToken: "", oneBotTokens: [ONEBOT_TOKEN] });
  assert.equal(open.authorize({ method: "GET", path: "/api/state" }), true);
  assert.equal(open.authorize({ method: "POST", path }), false);
});

test("CORS reflects only configured console origins", () => {
  const { http } = access({
    host: "panel.local",
    extraOrigins: "http://192.168.1.50:9000, *, https://console.example"
  });
  assert.deepEqual(http.corsHeaders({ headers: { origin: "http://127.0.0.1:3789" } })["access-control-allow-origin"], "http://127.0.0.1:3789");
  assert.equal(http.corsHeaders({ headers: { origin: "http://localhost:3789" } })["access-control-allow-origin"], "http://localhost:3789");
  assert.equal(http.corsHeaders({ headers: { origin: "http://[::1]:3789" } })["access-control-allow-origin"], "http://[::1]:3789");
  assert.equal(http.corsHeaders({ headers: { origin: "http://panel.local:3789" } })["access-control-allow-origin"], "http://panel.local:3789");
  assert.equal(http.corsHeaders({ headers: { origin: "http://192.168.1.50:9000" } })["access-control-allow-origin"], "http://192.168.1.50:9000");
  assert.equal(http.corsHeaders({ headers: { origin: "https://console.example" } })["access-control-allow-origin"], "https://console.example");
  assert.equal(http.corsHeaders({ headers: { origin: "null" } })["access-control-allow-origin"], "null");
  for (const origin of ["https://evil.example", "http://127.0.0.1:3790", "*", "file:///tmp/client.html"]) {
    const headers = http.corsHeaders({ headers: { origin } });
    assert.equal(headers["access-control-allow-origin"], undefined, origin);
    assert.equal(Object.values(headers).includes("*"), false);
  }
  const anonymous = http.corsHeaders({ headers: {} });
  assert.equal(anonymous["access-control-allow-origin"], undefined);
  assert.equal(anonymous.vary, "Origin");
  assert.match(anonymous["access-control-allow-headers"], /authorization/);
  assert.match(anonymous["access-control-allow-headers"], /x-codex-remote-token/);
  const closed = createHttpAccess({ allowFileOrigin: "0", port: 3789 });
  assert.equal(closed.corsHeaders({ headers: { origin: "null" } })["access-control-allow-origin"], undefined);
  assert.equal(closed.corsHeaders({ headers: { origin: "file://" } })["access-control-allow-origin"], undefined);
  const wildcardBind = createHttpAccess({ host: "0.0.0.0", port: 3789, allowFileOrigin: false });
  assert.equal(wildcardBind.allowedOrigins().includes("http://0.0.0.0:3789"), false);
});

test("browser grant lifetime is clamped and old grants are forgotten", () => {
  assert.equal(createHttpAccess({ grantTtlMs: 1 }).grantTtlMs, 60_000);
  assert.equal(createHttpAccess({ grantTtlMs: 9_999_999 }).grantTtlMs, 3_600_000);
  assert.equal(createHttpAccess({ grantTtlMs: "nope" }).grantTtlMs, 600_000);
  const { http } = access({ maxActiveGrants: 2 });
  const first = http.issueBrowserGrant({ headers: { origin: "http://127.0.0.1:3789" } });
  http.issueBrowserGrant({ headers: { origin: "http://127.0.0.1:3789" } });
  http.issueBrowserGrant({ headers: { origin: "http://127.0.0.1:3789" } });
  const headers = { origin: "http://127.0.0.1:3789" };
  assert.equal(http.authorize({ method: "GET", path: "/api/qq/stream", headers, searchParams: query(first.accessToken) }), false);
});

test("the hub and console no longer publish the long-lived token in URLs or wildcard CORS", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const client = await readFile(new URL("../modules/web-console/public/client.js", import.meta.url), "utf8");
  assert.match(server, /createHttpAccess/);
  assert.match(server, /\/api\/auth\/browser-grant/);
  assert.doesNotMatch(server, /access-control-allow-origin["']?\s*[:=]\s*["']\*["']/);
  assert.match(client, /\/api\/auth\/browser-grant/);
  assert.match(client, /browserGrant\.token/);
  assert.doesNotMatch(client, /parameters\.set\("access_token", token\)/);
  assert.doesNotMatch(client, /localStorage\.getItem\("crc-hub-token"\)[\s\S]{0,120}access_token/);
});

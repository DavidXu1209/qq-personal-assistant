import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { requestPage, extractPage } from "../src/qq/link-reader.js";

async function fixture(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  // Exercise only the transport with a private test fixture. Production
  // PublicLinkReader validates public addresses before calling this function.
  return { url: new URL(`http://reader.test:${server.address().port}/`), addresses: [{ address: "127.0.0.1", family: 4 }] };
}

test("native reader decodes gzip, x-gzip, deflate, Brotli and stacked encodings", async (t) => {
  const html = Buffer.from("<title>视频标题</title><p>这是真正的简介。</p>");
  const formats = { gzip: gzipSync(html), "x-gzip": gzipSync(html), deflate: deflateSync(html), br: brotliCompressSync(html),
    "gzip, br": brotliCompressSync(gzipSync(html)), identity: html };
  for (const [encoding, data] of Object.entries(formats)) await t.test(encoding, async (t) => {
    const target = await fixture(t, (request, response) => {
      assert.equal(request.headers["accept-encoding"], "identity");
      assert.equal(request.headers.cookie, undefined);
      assert.equal(request.headers.authorization, undefined);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": encoding });
      response.end(data);
    });
    const result = await requestPage(target, { signal: AbortSignal.timeout(2000) });
    assert.deepEqual(result.bytes, html);
    const page = extractPage(result.bytes, result.headers["content-type"], target.url);
    assert.equal(page.title, "视频标题");
    assert.match(page.text, /真正的简介/);
  });
});

test("compressed reader caps wire bytes, decoded bytes and intermediate layers", async (t) => {
  const oversized = Buffer.from("x".repeat(10_000));
  const cases = [
    { encoding: "identity", data: oversized, error: /传输内容超过/ },
    { encoding: "gzip", data: gzipSync(oversized), error: /解压内容超过/ },
    { encoding: "br", data: brotliCompressSync(oversized), error: /解压内容超过/ },
    { encoding: "gzip, br", data: brotliCompressSync(gzipSync(oversized)), error: /解压内容超过/ },
    // A padded inner gzip stream would decode to "tiny", but its intermediate
    // representation exceeds the cap before the inner decoder can consume it.
    { encoding: "gzip, br", data: brotliCompressSync(Buffer.concat([gzipSync(Buffer.from("tiny")), Buffer.alloc(5000)])), error: /解压内容超过/ }
  ];
  for (const item of cases) await t.test(item.encoding, async (t) => {
    const target = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain", "content-encoding": item.encoding });
      response.write(item.data); response.end(); // Chunked: no Content-Length shortcut.
    });
    await assert.rejects(requestPage(target, { maxBytes: 1024, signal: AbortSignal.timeout(2000) }), item.error);
  });
});

test("compressed reader rejects malformed, unsupported, non-text and oversized responses", async (t) => {
  const cases = [
    { encoding: "zstd", data: Buffer.from("unknown"), error: /未支持的压缩/ },
    { encoding: "gzip, gzip, gzip, gzip", data: Buffer.alloc(0), error: /未支持的压缩/ },
    { encoding: "gzip", data: gzipSync(Buffer.from("hello")).subarray(0, 12), error: /unexpected|invalid|错误/i },
    { encoding: "br", data: Buffer.from("not brotli"), error: /decompress|Brotli|error/i },
    { type: "image/png", encoding: "identity", data: Buffer.alloc(0), error: /不是可读取的文字/ },
    { encoding: "identity", data: Buffer.alloc(0), length: 2048, error: /传输内容超过/ }
  ];
  for (const [index, item] of cases.entries()) await t.test(String(index), async (t) => {
    const target = await fixture(t, (_request, response) => {
      response.writeHead(200, { "content-type": item.type || "text/plain", "content-encoding": item.encoding,
        ...(item.length ? { "content-length": item.length } : {}) });
      response.end(item.data);
    });
    await assert.rejects(requestPage(target, { maxBytes: 1024, signal: AbortSignal.timeout(2000) }), item.error);
  });
});

test("request deadline aborts an unfinished compressed response", async (t) => {
  const target = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    response.write(gzipSync(Buffer.from("hello")).subarray(0, 12));
    // Intentionally never finish: the transport must close without hanging.
  });
  await assert.rejects(requestPage(target, { signal: AbortSignal.timeout(80) }), /abort/i);
});

// Proxy hardening tests: node --test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket } from "ws";
import { createProxy } from "../server/proxy.js";
import { loadConfig } from "../server/config.js";
import { isPrivateAddress, createPolicy } from "../server/policy.js";

let upstream, upstreamUrl, secondUpstream, secondUpstreamUrl, proxyServer, base, limitedServer, limitedBase;

function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
}

function makeProxyServer(env) {
  const proxy = createProxy(loadConfig({ O4W_SECRET: "test", ...env }));
  const s = http.createServer(async (req, res) => {
    if (!(await proxy.handle(req, res))) res.writeHead(404).end();
  });
  proxy.attach(s);
  return s;
}

before(async () => {
  secondUpstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        auth: req.headers.authorization || null,
        cookie: req.headers.cookie || null,
        xff: req.headers["x-forwarded-for"] || null,
      }),
    );
  });
  secondUpstreamUrl = await listen(secondUpstream);

  upstream = http.createServer((req, res) => {
    if (req.url === "/redirect-out") return res.writeHead(302, { Location: "http://localhost:1/secret" }).end();
    if (req.url === "/redirect-in") return res.writeHead(302, { Location: "/hello" }).end();
    if (req.url === "/redirect-cross") return res.writeHead(302, { Location: secondUpstreamUrl + "/echo" }).end();
    if (req.url === "/big") {
      res.writeHead(200, { "Content-Length": String(5 * 1048576) });
      return res.end(Buffer.alloc(5 * 1048576));
    }
    if (req.url === "/big-html-chunked") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write("<!doctype html><head></head><body>");
      res.end("x".repeat(2 * 1048576));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain", "X-Echo-Origin": req.headers.origin || "", "Set-Cookie": "a=b" });
    res.end(
      "hello " +
        req.method +
        " " +
        (req.headers["user-agent"] || "") +
        (req.headers["x-forwarded-for"] ? " xff=" + req.headers["x-forwarded-for"] : ""),
    );
  });
  upstreamUrl = await listen(upstream);
  // Upstream is on loopback, so allow private addresses but only that exact host.
  proxyServer = makeProxyServer({
    O4W_PROXY_ALLOW_PRIVATE: "1",
    O4W_PROXY_ALLOW_HOSTS: "127.0.0.1",
    O4W_MAX_RESPONSE_MB: "1",
  });
  base = await listen(proxyServer);
  limitedServer = makeProxyServer({ O4W_PROXY_ALLOW_PRIVATE: "1", O4W_PROXY_ALLOW_HOSTS: "127.0.0.1", O4W_RATE_LIMIT_RPM: "3" });
  limitedBase = await listen(limitedServer);
});

after(() => {
  upstream.close();
  secondUpstream.close();
  proxyServer.close();
  limitedServer.close();
});

async function session(b = base) {
  const r = await fetch(b + "/__proxy/session", { method: "POST", headers: { Origin: b } });
  assert.equal(r.status, 204);
  return r.headers.get("set-cookie").split(";")[0];
}

const relay = (b, url, headers = {}) =>
  fetch(`${b}/__proxy?url=${encodeURIComponent(url)}`, { headers: { "Sec-Fetch-Site": "same-origin", "X-O4W-Proxy": "1", ...headers }, redirect: "manual" });

test("private address detection (IPv4 and canonical/non-canonical IPv6)", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "0:0:0:0:0:0:0:0",
    "fd00::1",
    "fe80::1",
    "fe80::1%lo0",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::127.0.0.1",
    "::7f00:1",
    "::ffff:0:127.0.0.1",
    "64:ff9b::127.0.0.1",
    "2002:7f00:1::",
    "2001::1",
    "2001:db8::1",
    "224.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["1.1.1.1", "140.82.112.3", "2606:4700::1111", "::ffff:1.1.1.1", "0:0:0:0:0:ffff:101:101"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("policy: allowlist, private destinations, trailing dots, protocols", () => {
  const p = createPolicy(loadConfig({ O4W_SECRET: "x" }));
  assert.ok(p.checkUrl("https://api.obsidian.md/x", "http"));
  assert.ok(p.checkUrl("https://github.com/a/b", "http"));
  assert.throws(() => p.checkUrl("https://evil.example/", "http"), /not allowed/);
  assert.throws(() => p.checkUrl("http://127.0.0.1/", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://169.254.169.254/latest/meta-data", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://localhost:8080/", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://localhost.:8080/", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://svc.internal./", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://0x7f.1./", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://[::127.0.0.1]/", "http"), /Private/);
  assert.throws(() => p.checkUrl("http://[2002:7f00:1::]/", "http"), /Private/);
  assert.throws(() => p.checkUrl("file:///etc/passwd", "http"), /protocol/);
  assert.throws(() => p.checkUrl("https://user:pw@github.com/", "http"), /Credentials/);
  assert.throws(() => p.checkUrl("https://obsidian.md.evil.example/", "http"), /not allowed/);
  const open = createPolicy(loadConfig({ O4W_SECRET: "x", O4W_PROXY_MODE: "open" }));
  assert.ok(open.checkUrl("https://evil.example/", "http"));
  assert.throws(() => open.checkUrl("http://10.0.0.1/", "http"), /Private/);
  assert.throws(() => open.checkUrl("http://localhost./", "http"), /Private/);
  assert.throws(() => open.checkUrl("http://[::127.0.0.1]/", "http"), /Private/);
});

test("safe lookup refuses hostnames resolving to private addresses", async () => {
  const p = createPolicy(loadConfig({ O4W_SECRET: "x", O4W_PROXY_MODE: "open" }));
  await assert.rejects(new Promise((res, rej) => p.safeLookup("localhost", {}, (e, a) => (e ? rej(e) : res(a)))), /private/);
});

test("health endpoint describes capabilities", async () => {
  const r = await fetch(base + "/__proxy/health");
  const body = await r.json();
  assert.equal(body.proxy, true);
  assert.equal(body.mode, "allowlist");
  assert.ok(body.allowHosts.includes("127.0.0.1"));
});

test("session is only issued to same-origin pages", async () => {
  assert.equal((await fetch(base + "/__proxy/session", { method: "POST" })).status, 403);
  assert.equal((await fetch(base + "/__proxy/session", { method: "POST", headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await fetch(base + "/__proxy/session", { method: "GET", headers: { Origin: base } })).status, 405);
  await session();
});

test("relay requires header, same-site and a valid session, and blocks forwarding header smuggling", async () => {
  const cookie = await session();
  const url = upstreamUrl + "/hello";
  assert.equal((await relay(base, url, { "X-O4W-Proxy": "", Cookie: cookie })).status, 403);
  assert.equal((await relay(base, url, { Origin: "https://evil.example", Cookie: cookie })).status, 403);
  assert.equal((await relay(base, url, { "Sec-Fetch-Site": "cross-site", Cookie: cookie })).status, 403);
  assert.equal((await relay(base, url)).status, 401);
  assert.equal((await relay(base, url, { Cookie: "o4w_session=forged.token" })).status, 401);
  const ok = await relay(base, url, {
    Cookie: cookie,
    "X-O4W-Headers": encodeURIComponent(JSON.stringify({ "User-Agent": "Obsidian", "X-Forwarded-For": "1.2.3.4" })),
  });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "hello GET Obsidian");
  assert.equal(ok.headers.get("set-cookie"), null, "upstream cookies are not passed on");
  assert.equal(ok.headers.get("content-security-policy"), "sandbox");
});

test("destinations outside the allowlist are refused", async () => {
  const cookie = await session();
  assert.equal((await relay(base, "https://example.com/", { Cookie: cookie })).status, 403);
});

test("redirects are re-checked against policy and strip credentials across origins", async () => {
  const cookie = await session();
  const inside = await relay(base, upstreamUrl + "/redirect-in", { Cookie: cookie });
  assert.equal(inside.status, 200);
  assert.match(await inside.text(), /^hello/);
  const outside = await relay(base, upstreamUrl + "/redirect-out", { Cookie: cookie });
  assert.equal(outside.status, 403);
  const cross = await relay(base, upstreamUrl + "/redirect-cross", {
    Cookie: cookie,
    "X-O4W-Headers": encodeURIComponent(JSON.stringify({ Authorization: "Bearer secret", Cookie: "s=1" })),
  });
  assert.equal(cross.status, 200);
  assert.deepEqual(await cross.json(), { auth: null, cookie: null, xff: null });
});

test("response size is capped for both normal relay and chunked page-mode HTML", async () => {
  const cookie = await session();
  const r = await relay(base, upstreamUrl + "/big", { Cookie: cookie });
  assert.equal(r.status, 502);
  const page = await fetch(`${base}/__proxy?mode=page&url=${encodeURIComponent(upstreamUrl + "/big-html-chunked")}`, {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "iframe" },
  });
  assert.equal(page.status, 502);
});

test("rate limiting", async () => {
  const cookie = await session(limitedBase);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await relay(limitedBase, upstreamUrl + "/hello", { Cookie: cookie })).status);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  assert.equal(statuses[4], 429);
});

test("web viewer page mode is off in allowlist mode and only framable", async () => {
  const cookie = await session();
  const r = await fetch(`${base}/__proxy?mode=page&url=${encodeURIComponent("https://example.com/")}`, {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "iframe" },
  });
  assert.equal(r.status, 403);
  const top = await fetch(`${base}/__proxy?mode=page&url=${encodeURIComponent(upstreamUrl + "/hello")}`, {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "document" },
  });
  assert.equal(top.status, 403);
});

test("websocket relay rejects foreign origins and missing sessions", async () => {
  const wsBase = base.replace("http", "ws");
  const tryWs = (headers) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${wsBase}/__wsproxy?url=${encodeURIComponent("wss://sync.obsidian.md/")}`, { headers });
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
    });
  assert.equal(await tryWs({ Origin: "https://evil.example" }), 403);
  assert.equal(await tryWs({ Origin: base }), 401);
});

test("allowlisted names resolving to private addresses are refused at connect time", async (t) => {
  // localtest.me is public DNS that resolves to 127.0.0.1 (simulates DNS rebinding).
  const dns = await import("node:dns/promises");
  try {
    await dns.lookup("localtest.me");
  } catch {
    t.skip("no DNS available");
    return;
  }
  const s = makeProxyServer({ O4W_PROXY_ALLOW_HOSTS: "localtest.me" });
  const b = await listen(s);
  try {
    const cookie = await session(b);
    const port = new URL(upstreamUrl).port;
    const r = await relay(b, `http://localtest.me:${port}/hello`, { Cookie: cookie });
    assert.equal(r.status, 403);
    assert.match(await r.text(), /private address/);
  } finally {
    s.close();
  }
});

test("multiple hostnames: forwarded host behind a trusted reverse proxy, explicit origins", async () => {
  const trusted = makeProxyServer({ O4W_TRUST_PROXY: "1", O4W_ALLOWED_ORIGINS: "https://other.example" });
  const b = await listen(trusted);
  const untrusted = makeProxyServer({});
  const b2 = await listen(untrusted);
  try {
    const post = (url, headers) => fetch(url + "/__proxy/session", { method: "POST", headers }).then((r) => r.status);
    // Reverse proxy forwards notes.example.com; the browser's Origin is that host.
    assert.equal(await post(b, { Origin: "https://notes.example.com", "X-Forwarded-Host": "notes.example.com" }), 204);
    assert.equal(await post(b, { Origin: "https://second.example.net", "X-Forwarded-Host": "second.example.net" }), 204);
    assert.equal(await post(b, { Origin: "https://other.example" }), 204);
    assert.equal(await post(b, { Origin: "https://evil.example", "X-Forwarded-Host": "notes.example.com" }), 403);
    // Without O4W_TRUST_PROXY the forwarded host is ignored.
    assert.equal(await post(b2, { Origin: "https://notes.example.com", "X-Forwarded-Host": "notes.example.com" }), 403);
    assert.equal(await post(b2, { Origin: b2 }), 204);
  } finally {
    trusted.close();
    untrusted.close();
  }
});

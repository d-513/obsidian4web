// CORS / WebSocket proxy for obsidian4web.
//
//   GET  /__proxy/health                 capabilities (mode, allowed hosts, web viewer)
//   POST /__proxy/session                issue the session cookie (same-origin pages only)
//   ANY  /__proxy?url=<encoded url>      relay (header X-O4W-Proxy: 1, X-O4W-Headers = encoded JSON)
//   GET  /__proxy?mode=page&url=…        web viewer page (sandboxed, bridge injected)
//   WS   /__wsproxy?url=<encoded ws url> WebSocket relay
//
// It is not an open relay: callers must be pages of this site (Origin / Fetch Metadata
// checks + custom header + signed session cookie), destinations are restricted (allowlist
// by default, never private networks, every redirect hop re-checked, DNS checked at
// connect time), and requests are rate limited and size limited.

import { Readable } from "node:stream";
import { Agent, fetch as undiciFetch } from "undici";
import { WebSocketServer, WebSocket } from "ws";
import { loadConfig } from "./config.js";
import { createPolicy, PolicyError } from "./policy.js";
import { RateLimiter } from "./limits.js";
import { createSessions } from "./session.js";
import { injectBridge } from "./bridge.js";

const OBSIDIAN_HOST = /(^|\.)obsidian\.md$/i;
const OBSIDIAN_ORIGIN = "app://obsidian.md";
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const MAX_PAGE_HTML_BYTES = 16 * 1048576;

// Response CSP: proxied content must never run with this site's origin.
const SANDBOX_STRICT = "sandbox";
const SANDBOX_PAGE = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "cookie",
  "origin",
  "referer",
  "accept-encoding",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "proxy-authorization",
  "proxy-connection",
  "x-o4w-headers",
  "x-o4w-proxy",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "upgrade-insecure-requests",
  "priority",
]);

// Headers that cannot be smuggled even via X-O4W-Headers (hop-by-hop & proxy forwarding).
const FORBIDDEN_EXTRA_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "proxy-authorization",
  "proxy-connection",
  "x-o4w-headers",
  "x-o4w-proxy",
]);

const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "strict-transport-security",
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "cross-origin-resource-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "access-control-allow-origin",
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-expose-headers",
  "alt-svc",
  "clear-site-data",
  "refresh",
  "link",
]);

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND", "PROPPATCH", "MKCOL", "COPY", "MOVE", "LOCK", "UNLOCK"]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function firstHeader(v) {
  return (Array.isArray(v) ? v[0] : v || "").split(",")[0].trim();
}

export function createProxy(config = loadConfig()) {
  const policy = createPolicy(config);
  const limiter = new RateLimiter(config.limits);
  const sessions = createSessions(config);
  const agent = new Agent({
    connect: { lookup: policy.safeLookup, timeout: 15e3 },
    headersTimeout: config.limits.timeoutMs,
    bodyTimeout: config.limits.timeoutMs,
    keepAliveTimeout: 10e3,
  });
  const log = (...a) => config.log && console.log("[proxy]", ...a);

  if (config.secretIsEphemeral && config.mode !== "off") {
    console.warn("[proxy] O4W_SECRET is not set; sessions reset on restart and can't be shared between instances.");
  }

  // ---------------------------------------------------------------------------
  // Request identity

  function clientIp(req) {
    if (config.trustProxy) {
      // The last entry is the one appended by our own reverse proxy; earlier ones are client-controlled.
      const chain = String(req.headers["x-forwarded-for"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (chain.length) return chain[chain.length - 1];
    }
    return req.socket.remoteAddress || "unknown";
  }

  function isSecure(req) {
    if (req.socket.encrypted) return true;
    return config.trustProxy && firstHeader(req.headers["x-forwarded-proto"]) === "https";
  }

  /** Hostnames under which this server is reached (multi-hostname deployments). */
  function ownHosts(req) {
    const hosts = new Set();
    if (req.headers.host) hosts.add(req.headers.host.toLowerCase());
    if (config.trustProxy) {
      const fh = firstHeader(req.headers["x-forwarded-host"]);
      if (fh) hosts.add(fh.toLowerCase());
    }
    return hosts;
  }

  function originAllowed(origin, req) {
    let u;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    if (ownHosts(req).has(u.host.toLowerCase())) return true;
    return config.allowedOrigins.some((o) => o === u.origin.toLowerCase() || o === u.host.toLowerCase() || o === u.hostname.toLowerCase());
  }

  /** Same-site browser request from one of our pages. */
  function fromOurPages(req) {
    const origin = req.headers.origin;
    if (origin && origin !== "null") return originAllowed(origin, req);
    const site = req.headers["sec-fetch-site"];
    // Requests without Origin: same-origin GETs and navigations. Browsers always send Fetch Metadata.
    return site === "same-origin";
  }

  function securityHeaders(pageMode) {
    return {
      "Content-Security-Policy": pageMode ? SANDBOX_PAGE : SANDBOX_STRICT,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    };
  }

  function fail(res, status, message, pageMode = false) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { ...securityHeaders(pageMode), "Content-Type": "text/plain; charset=utf-8", "X-O4W-Error": "1" });
    res.end(message);
  }

  // ---------------------------------------------------------------------------
  // HTTP

  async function readBody(req, keys, signal) {
    const max = config.limits.maxRequestBody;
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > max) throw new HttpError(413, "Request body too large");
    const chunks = [];
    let size = 0;
    const onAbort = () => req.destroy();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const c of req) {
        if (signal?.aborted) throw new HttpError(504, "Upstream timed out");
        size += c.length;
        if (size > max) throw new HttpError(413, "Request body too large");
        if (!keys.every((k) => limiter.addBytes(k, c.length))) throw new HttpError(429, "Transfer quota exceeded");
        chunks.push(c);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    return Buffer.concat(chunks);
  }

  async function readBoundedText(webBody, maxBytes, keys) {
    const reader = webBody.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new HttpError(502, "Upstream response too large");
        }
        if (!keys.every((k) => limiter.addBytes(k, value.byteLength))) {
          await reader.cancel().catch(() => {});
          throw new HttpError(429, "Transfer quota exceeded");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function buildHeaders(req, target) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (!DROP_REQUEST_HEADERS.has(key) && typeof v === "string") out[key] = v;
    }
    const extra = req.headers["x-o4w-headers"];
    if (typeof extra === "string") {
      let parsed;
      try {
        parsed = JSON.parse(decodeURIComponent(extra));
      } catch {
        throw new HttpError(400, "Malformed X-O4W-Headers");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpError(400, "Malformed X-O4W-Headers");
      }
      for (const [k, v] of Object.entries(parsed)) {
        const key = k.toLowerCase();
        if (!HEADER_NAME_RE.test(key) || FORBIDDEN_EXTRA_HEADERS.has(key)) continue;
        const val = String(v);
        if (/[\r\n\0]/.test(val)) throw new HttpError(400, "Invalid header value");
        out[key] = val;
      }
    }
    if (OBSIDIAN_HOST.test(target.hostname) && !out.origin) out.origin = OBSIDIAN_ORIGIN;
    return out;
  }

  /** fetch with manual redirects so every hop goes through the policy. */
  async function fetchFollowing(target, init, kind) {
    let url = target;
    let { method, body } = init;
    const headers = { ...init.headers };
    for (let hop = 0; ; hop++) {
      const res = await undiciFetch(url, { ...init, headers, method, body, redirect: "manual", dispatcher: agent });
      if (![301, 302, 303, 307, 308].includes(res.status)) return { res, finalUrl: url };
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc) return { res, finalUrl: url };
      if (hop >= config.limits.maxRedirects) throw new HttpError(508, "Too many redirects");
      const nextUrl = policy.checkUrl(new URL(loc, url).href, kind);
      if (nextUrl.origin !== url.origin) {
        delete headers.authorization;
        delete headers.cookie;
        delete headers["proxy-authorization"];
        delete headers.origin;
        if (OBSIDIAN_HOST.test(nextUrl.hostname)) headers.origin = OBSIDIAN_ORIGIN;
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        delete headers["content-type"];
        delete headers["content-length"];
        delete headers["content-encoding"];
      }
      url = nextUrl;
    }
  }

  async function handleRelay(req, res, u) {
    const pageMode = u.searchParams.get("mode") === "page";
    if (config.mode === "off") return fail(res, 404, "Proxy disabled");
    if (!METHODS.has(req.method)) return fail(res, 405, "Method not allowed");
    if (!fromOurPages(req)) return fail(res, 403, "Cross-origin use of this proxy is not allowed", pageMode);
    if (pageMode) {
      if (req.method !== "GET") return fail(res, 405, "Method not allowed", true);
      const dest = req.headers["sec-fetch-dest"];
      if (dest && dest !== "iframe") return fail(res, 403, "Web viewer pages can only be framed", true);
    } else if (req.headers["x-o4w-proxy"] !== "1") {
      // A custom header can't be sent cross-site without a CORS preflight, which we never approve.
      return fail(res, 403, "Missing X-O4W-Proxy header");
    }
    const sid = sessions.fromRequest(req);
    if (!sid) return fail(res, 401, "Session required", pageMode);

    const keys = [`ip:${clientIp(req)}`, `s:${sid}`];
    for (let i = 0; i < keys.length; i++) {
      const reason = limiter.begin(keys[i]);
      if (reason) {
        for (let j = 0; j < i; j++) limiter.end(keys[j]);
        res.setHeader("Retry-After", "30");
        return fail(res, 429, reason, pageMode);
      }
    }
    const abort = new AbortController();
    const overall = setTimeout(() => abort.abort(new HttpError(504, "Upstream timed out")), config.limits.timeoutMs);
    res.on("close", () => abort.abort());
    try {
      const target = policy.checkUrl(u.searchParams.get("url") || "", pageMode ? "page" : "http");
      const headers = buildHeaders(req, target);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req, keys, abort.signal);
      const { res: upstream, finalUrl } = await fetchFollowing(
        target,
        { method: req.method, headers, body: body && body.length ? body : undefined, signal: abort.signal },
        pageMode ? "page" : "http",
      );
      log(req.method, target.href, "→", upstream.status);

      const maxBody = pageMode ? Math.min(config.limits.maxResponseBody, MAX_PAGE_HTML_BYTES) : config.limits.maxResponseBody;
      const declared = Number(upstream.headers.get("content-length") || 0);
      if (declared > maxBody) {
        await upstream.body?.cancel().catch(() => {});
        throw new HttpError(502, "Upstream response too large");
      }

      const out = { ...securityHeaders(pageMode) };
      const exposed = {};
      upstream.headers.forEach((v, k) => {
        exposed[k] = v;
        if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v;
      });
      out["Cache-Control"] = "no-store";
      if (declared && !upstream.headers.get("content-encoding")) out["X-O4W-Content-Length"] = String(declared);
      out["X-O4W-Status"] = String(upstream.status);
      out["X-O4W-Final-Url"] = encodeURIComponent(finalUrl.href);
      out["X-O4W-Response-Headers"] = encodeURIComponent(JSON.stringify(exposed));

      let status = upstream.status;
      if (status < 200 || status === 204 || status === 205 || status === 304 || status > 599) status = 200;

      const contentType = upstream.headers.get("content-type") || "";
      if (pageMode && /text\/html/i.test(contentType) && upstream.body) {
        const text = await readBoundedText(upstream.body, maxBody, keys);
        delete out["X-O4W-Content-Length"];
        res.writeHead(status, out);
        res.end(injectBridge(text, finalUrl.href));
        return;
      }
      res.writeHead(status, out);
      if (req.method === "HEAD" || !upstream.body) {
        res.end();
        return;
      }
      let sent = 0;
      const stream = Readable.fromWeb(upstream.body);
      stream.on("data", (chunk) => {
        sent += chunk.length;
        const okQuota = keys.every((k) => limiter.addBytes(k, chunk.length));
        if (sent > config.limits.maxResponseBody || !okQuota) {
          stream.destroy();
          res.destroy();
        }
      });
      stream.on("error", () => res.destroy());
      await new Promise((resolve) => {
        res.on("close", resolve);
        stream.pipe(res);
      });
    } catch (e) {
      const err = e?.cause instanceof PolicyError ? e.cause : e;
      const status = err instanceof PolicyError || err instanceof HttpError ? err.status : abort.signal.aborted ? 504 : 599;
      log("error", u.searchParams.get("url"), status, err?.message);
      fail(res, status, String(err?.message || err), pageMode);
    } finally {
      clearTimeout(overall);
      for (const k of keys) limiter.end(k);
    }
  }

  function handleHealth(req, res) {
    const body = {
      proxy: config.mode !== "off",
      mode: config.mode,
      webviewer: config.mode !== "off" && config.webviewer,
      allowHosts: config.mode === "allowlist" ? config.allowHosts : null,
    };
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  function handleSession(req, res) {
    if (config.mode === "off") return fail(res, 404, "Proxy disabled");
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    // POST requests always carry Origin in browsers; only our own pages get a session.
    if (!req.headers.origin || !originAllowed(req.headers.origin, req)) return fail(res, 403, "Not allowed");
    const reason = limiter.begin(`sess:${clientIp(req)}`);
    if (reason) return fail(res, 429, reason);
    limiter.end(`sess:${clientIp(req)}`);
    res.writeHead(204, { "Set-Cookie": sessions.cookieHeader(isSecure(req)), "Cache-Control": "no-store" });
    res.end();
  }

  /** Node http handler. Returns true if the request was handled. */
  async function handle(req, res) {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname === "/__proxy/health") return handleHealth(req, res), true;
    if (u.pathname === "/__proxy/session") return handleSession(req, res), true;
    if (u.pathname !== "/__proxy" && u.pathname !== "/__proxy/") return false;
    await handleRelay(req, res, u);
    return true;
  }

  // ---------------------------------------------------------------------------
  // WebSocket

  function attach(server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.wsMaxMessage });
    server.on("upgrade", (req, socket, head) => {
      const u = new URL(req.url, "http://localhost");
      if (u.pathname !== "/__wsproxy" && u.pathname !== "/__wsproxy/") return;
      socket.on("error", () => socket.destroy());
      const reject = (code, text) => {
        if (!socket.destroyed && socket.writable) {
          socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
        }
        socket.destroy();
      };
      if (config.mode === "off") return reject(404, "Not Found");
      // Browsers always send Origin on WebSocket handshakes.
      if (!req.headers.origin || !originAllowed(req.headers.origin, req)) return reject(403, "Forbidden");
      const sid = sessions.fromRequest(req);
      if (!sid) return reject(401, "Unauthorized");
      let target;
      try {
        target = policy.checkUrl(u.searchParams.get("url") || "", "ws");
      } catch (e) {
        return reject(e.status || 400, "Bad Request");
      }
      const keys = [`ip:${clientIp(req)}`, `s:${sid}`];
      for (let i = 0; i < keys.length; i++) {
        const reason = limiter.beginWs(keys[i]);
        if (reason) {
          for (let j = 0; j < i; j++) limiter.endWs(keys[j]);
          return reject(429, "Too Many Requests");
        }
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        for (const k of keys) limiter.endWs(k);
      };
      const protocols = (req.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const upstream = new WebSocket(target, protocols, {
        origin: OBSIDIAN_HOST.test(target.hostname) ? OBSIDIAN_ORIGIN : undefined,
        headers: { "user-agent": req.headers["user-agent"] || "obsidian4web" },
        lookup: policy.safeLookup,
        maxPayload: config.limits.wsMaxMessage,
        followRedirects: false,
        handshakeTimeout: 15e3,
      });
      let client = null;
      socket.on("close", () => {
        release();
        if (upstream.readyState === WebSocket.CONNECTING || upstream.readyState === WebSocket.OPEN) {
          upstream.terminate();
        }
      });
      upstream.on("open", () => {
        if (socket.destroyed || !socket.readable || !socket.writable) {
          release();
          upstream.terminate();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          client = ws;
          log("ws open", target.href);
          ws.on("message", (data, isBinary) => {
            if (upstream.readyState !== WebSocket.OPEN) return;
            if (!keys.every((k) => limiter.addBytes(k, data.length ?? 0))) return ws.close(1008, "Quota exceeded");
            upstream.send(data, { binary: isBinary });
          });
          ws.on("close", (code, reason) => {
            release();
            upstream.close(normalizeCode(code), reason);
          });
          ws.on("error", () => upstream.terminate());
        });
      });
      upstream.on("message", (data, isBinary) => {
        if (client?.readyState !== WebSocket.OPEN) return;
        if (!keys.every((k) => limiter.addBytes(k, data.length ?? 0))) return client.close(1008, "Quota exceeded");
        client.send(data, { binary: isBinary });
      });
      upstream.on("close", (code, reason) => {
        release();
        if (client) client.close(normalizeCode(code), reason);
        else socket.destroy();
      });
      upstream.on("error", (e) => {
        release();
        log("ws error", target.href, e.message);
        if (client) client.terminate();
        else reject(502, "Bad Gateway");
      });
    });
  }

  return { handle, attach, config };
}

function normalizeCode(code) {
  return code === 1005 || code === 1006 || code === 1015 || !code ? 1000 : code;
}

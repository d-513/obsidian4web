// CORS proxy used by obsidian4web: HTTP(S) requests and WebSockets.
//
//   GET/POST/... /__proxy?url=<encoded url>     (headers to send: X-O4W-Headers = encodeURIComponent(JSON))
//   WebSocket    /__wsproxy?url=<encoded ws(s) url>
//
// Requests to private/loopback addresses are refused unless O4W_PROXY_ALLOW_PRIVATE=1.
// Restrict the allowed destination hosts with O4W_PROXY_ALLOW_HOSTS="a.com,.b.com".

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";

const MAX_BODY = 512 * 1024 * 1024;
const ALLOW_PRIVATE = process.env.O4W_PROXY_ALLOW_PRIVATE === "1";
const ALLOW_HOSTS = (process.env.O4W_PROXY_ALLOW_HOSTS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Hosts whose servers expect requests to come from the Obsidian app. */
const OBSIDIAN_HOST = /(^|\.)obsidian\.md$/i;
const OBSIDIAN_ORIGIN = "app://obsidian.md";

// Headers the browser adds that must not be forwarded.
const DROP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "cookie",
  "origin",
  "referer",
  "x-o4w-headers",
  "accept-encoding",
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

const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
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
]);

/** Only our own pages may use the proxy (prevents use as an open CORS proxy by other sites). */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") {
    // Navigations and same-origin GETs carry no Origin; fall back to Sec-Fetch-Site when present.
    const site = req.headers["sec-fetch-site"];
    return !site || site === "same-origin" || site === "none";
  }
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Response CSP: proxied content must never run with our origin's privileges. */
const SANDBOX_STRICT = "sandbox";
const SANDBOX_PAGE = "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

function isPrivateAddress(ip) {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

async function checkTarget(urlString, protocols) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!protocols.includes(url.protocol)) throw Object.assign(new Error("Unsupported protocol"), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (ALLOW_HOSTS.length && !ALLOW_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) || host === h.slice(1) : host === h))) {
    throw Object.assign(new Error("Destination host not allowed"), { status: 403 });
  }
  if (!ALLOW_PRIVATE) {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length) throw Object.assign(new Error(`Could not resolve ${host}`), { status: 502 });
    if (addrs.some((a) => isPrivateAddress(a.address))) {
      throw Object.assign(new Error("Requests to private network addresses are disabled"), { status: 403 });
    }
  }
  return url;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Node http handler. Returns true if the request was handled. */
export async function handleProxyRequest(req, res) {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/__proxy" && u.pathname !== "/__proxy/") return false;

  const pageMode = u.searchParams.get("mode") === "page";
  const cors = {
    "Content-Security-Policy": pageMode ? SANDBOX_PAGE : SANDBOX_STRICT,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (!isSameOrigin(req)) {
    res.writeHead(403, { ...cors, "Content-Type": "text/plain" });
    res.end("Cross-origin use of this proxy is not allowed");
    return true;
  }

  try {
    const target = await checkTarget(u.searchParams.get("url") || "", ["http:", "https:"]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!DROP_REQUEST_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }
    const extra = req.headers["x-o4w-headers"];
    if (typeof extra === "string") {
      try {
        Object.assign(headers, JSON.parse(decodeURIComponent(extra)));
      } catch {
        /* ignore malformed */
      }
    }
    // Lower-case dedupe; explicit headers from the app win.
    const finalHeaders = {};
    for (const [k, v] of Object.entries(headers)) finalHeaders[k.toLowerCase()] = String(v);
    if (OBSIDIAN_HOST.test(target.hostname) && !finalHeaders.origin) finalHeaders.origin = OBSIDIAN_ORIGIN;
    delete finalHeaders.host;

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers: finalHeaders,
      body: body && body.length ? body : undefined,
      redirect: "follow",
    });

    const outHeaders = { ...cors };
    const exposed = {};
    upstream.headers.forEach((v, k) => {
      exposed[k] = v;
      if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
    });
    const len = upstream.headers.get("content-length");
    if (len && !upstream.headers.get("content-encoding")) outHeaders["X-O4W-Content-Length"] = len;
    outHeaders["X-O4W-Status"] = String(upstream.status);
    outHeaders["X-O4W-Response-Headers"] = encodeURIComponent(JSON.stringify(exposed));
    outHeaders["Cache-Control"] = upstream.headers.get("cache-control") || "no-store";

    // Pass through the real status, except codes the browser would treat specially.
    let status = upstream.status;
    if (status < 200 || status === 204 || status === 205 || status === 304 || status > 599) status = 200;
    const contentType = upstream.headers.get("content-type") || "";
    if (pageMode && /text\/html/i.test(contentType) && upstream.body) {
      const html = injectBridge(await upstream.text(), upstream.url || target.href);
      delete outHeaders["X-O4W-Content-Length"];
      res.writeHead(status, outHeaders);
      res.end(html);
      return true;
    }
    res.writeHead(status, outHeaders);
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
    } else {
      Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
    }
  } catch (e) {
    const status = e.status || 599;
    if (!res.headersSent) res.writeHead(status, { ...cors, "Content-Type": "text/plain" });
    res.end(String(e.cause?.message || e.message || e));
  }
  return true;
}

/** Attach the WebSocket proxy to an http.Server. */
export function attachWebSocketProxy(server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", async (req, socket, head) => {
    const u = new URL(req.url, "http://localhost");
    if (u.pathname !== "/__wsproxy" && u.pathname !== "/__wsproxy/") return;
    let target;
    try {
      target = await checkTarget(u.searchParams.get("url") || "", ["ws:", "wss:"]);
    } catch (e) {
      socket.write(`HTTP/1.1 ${e.status || 400} Bad Request\r\n\r\n`);
      socket.destroy();
      return;
    }
    const protocols = (req.headers["sec-websocket-protocol"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!isSameOrigin(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const upstream = new WebSocket(target, protocols, {
      origin: OBSIDIAN_HOST.test(target.hostname) ? OBSIDIAN_ORIGIN : undefined,
      headers: { "user-agent": req.headers["user-agent"] || "obsidian4web" },
    });
    let client = null;
    upstream.on("open", () => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        client = ws;
        ws.on("message", (data, isBinary) => upstream.readyState === WebSocket.OPEN && upstream.send(data, { binary: isBinary }));
        ws.on("close", (code, reason) => upstream.close(normalizeCode(code), reason));
        ws.on("error", () => upstream.terminate());
      });
    });
    upstream.on("message", (data, isBinary) => client?.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
    upstream.on("close", (code, reason) => {
      if (client) client.close(normalizeCode(code), reason);
      else socket.destroy();
    });
    upstream.on("error", (e) => {
      if (client) client.terminate();
      else {
        socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        socket.destroy();
      }
      console.warn("[o4w-proxy] websocket error", target.href, e.message);
    });
  });
}

function normalizeCode(code) {
  return code === 1005 || code === 1006 || code === 1015 || !code ? 1000 : code;
}

// ---------------------------------------------------------------------------
// Web viewer pages: rendered in a sandboxed iframe; a small bridge script reports
// navigation/title/favicon to the embedding <webview> element and runs its requests.

const BRIDGE = `(() => {
  const REAL = __REAL_URL__;
  const post = (m) => parent.postMessage(Object.assign({ o4wWebview: 1 }, m), "*");
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch { return h; } };
  const favicons = () => [...document.querySelectorAll("link[rel~=icon]")].map((l) => abs(l.getAttribute("href")));
  post({ type: "did-start-loading", url: REAL });
  document.addEventListener("DOMContentLoaded", () => {
    post({ type: "dom-ready", url: REAL, title: document.title });
    post({ type: "page-title-updated", title: document.title || REAL });
    const t = document.querySelector("title");
    if (t) new MutationObserver(() => post({ type: "page-title-updated", title: document.title })).observe(t, { childList: true, characterData: true, subtree: true });
  });
  addEventListener("load", () => {
    post({ type: "page-favicon-updated", favicons: favicons() });
    post({ type: "did-finish-load", url: REAL });
    post({ type: "did-stop-loading" });
  });
  addEventListener("hashchange", () => post({ type: "did-navigate-in-page", url: REAL.split("#")[0] + location.hash }));
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    e.preventDefault();
    const url = abs(href);
    const newWin = a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey;
    post({ type: newWin ? "new-window" : "navigate", url });
  }, true);
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if ((f.method || "get").toLowerCase() !== "get") return;
    e.preventDefault();
    const u = new URL(f.action || REAL, document.baseURI);
    u.search = new URLSearchParams(new FormData(f)).toString();
    post({ type: "navigate", url: u.href });
  }, true);
  addEventListener("message", async (e) => {
    const m = e.data || {};
    if (!m.o4wWebviewCmd) return;
    let result = null, error = null;
    try {
      if (m.cmd === "exec") result = await (0, eval)(m.code);
      else if (m.cmd === "zoom") document.documentElement.style.zoom = String(m.factor);
      else if (m.cmd === "find") result = window.find(m.text, !!m.matchCase, !!m.backwards, true);
      else if (m.cmd === "css") { const s = document.createElement("style"); s.textContent = m.css; document.head.appendChild(s); }
      else if (m.cmd === "back") history.back();
      else if (m.cmd === "forward") history.forward();
      try { structuredClone(result); } catch { result = String(result); }
    } catch (err) { error = String(err && err.message || err); }
    e.source.postMessage({ o4wWebviewReply: 1, id: m.id, result, error }, "*");
  });
})();`;

function injectBridge(html, realUrl) {
  const head =
    `<base href="${realUrl.replace(/"/g, "&quot;")}">` +
    `<script>${BRIDGE.replace("__REAL_URL__", JSON.stringify(realUrl).replace(/</g, "\\u003c"))}</script>`;
  // Neutralise <meta http-equiv=Content-Security-Policy> (it would block the bridge) and existing <base>.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
  return head + html;
}

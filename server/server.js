// Production server: static files from dist/ + the proxy.
//   PORT=8080 O4W_SECRET=... node server/server.js
// See README "Deploying" for all options.
import http from "node:http";
import { createReadStream, statSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxy } from "./proxy.js";
import { loadConfig } from "./config.js";

const root = resolve(process.env.O4W_STATIC_DIR || fileURLToPath(new URL("../dist", import.meta.url)));
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";

if (!existsSync(join(root, "index.html"))) {
  console.error(`No build found in ${root}. Run "pnpm build" first.`);
  process.exit(1);
}

const config = loadConfig();
const proxy = createProxy(config);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

// Headers for our own documents/assets. Obsidian's pages are served by the service worker.
const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};

function cacheControl(path) {
  if (path.startsWith("/assets/")) return "public, max-age=31536000, immutable"; // hashed by Vite
  if (path === "/sw.js" || path.endsWith(".html") || path.endsWith(".webmanifest")) return "no-cache";
  return "public, max-age=3600, must-revalidate";
}

const server = http.createServer(async (req, res) => {
  try {
    if (await proxy.handle(req, res)) return;
    const url = new URL(req.url, "http://localhost");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, BASE_HEADERS).end();
      return;
    }
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, BASE_HEADERS).end();
      return;
    }
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root + "/") && file !== root) {
      res.writeHead(403, BASE_HEADERS).end();
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      st = null;
    }
    if (!st || !st.isFile()) {
      // Obsidian's files (e.g. /starter.html) before the service worker controls the page:
      // hand over to the launcher, which installs the worker and comes back.
      res.writeHead(302, { ...BASE_HEADERS, Location: "/?next=" + encodeURIComponent(url.pathname + url.search) }).end();
      return;
    }
    const headers = {
      ...BASE_HEADERS,
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": cacheControl(path),
      "Last-Modified": st.mtime.toUTCString(),
    };
    if (path === "/sw.js") headers["Service-Worker-Allowed"] = "/";
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.headersTimeout = 30e3;
server.requestTimeout = 0; // long transfers (proxy) are bounded by the proxy's own timeouts
server.keepAliveTimeout = 65e3;
proxy.attach(server);
server.on("upgrade", (req, socket) => {
  const u = new URL(req.url, "http://localhost");
  if (u.pathname !== "/__wsproxy" && u.pathname !== "/__wsproxy/") socket.destroy();
});
server.listen(port, host, () => {
  console.log(`obsidian4web on http://${host === "0.0.0.0" ? "localhost" : host}:${port}  (proxy: ${config.mode}${config.webviewer ? ", web viewer" : ""})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

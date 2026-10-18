// Production server: static files from dist/ + the CORS/WebSocket proxy.
//   PORT=8080 node server/server.js
import http from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleProxyRequest, attachWebSocketProxy } from "./proxy.js";

const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

const server = http.createServer(async (req, res) => {
  try {
    if (await handleProxyRequest(req, res)) return;
    const url = new URL(req.url, "http://localhost");
    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      // Unknown paths (e.g. Obsidian files before the service worker is active) go to the launcher.
      res.writeHead(302, { Location: "/?next=" + encodeURIComponent(url.pathname + url.search) }).end();
      return;
    }
    if (st.isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": path === "/sw.js" || path.endsWith(".html") ? "no-cache" : "public, max-age=3600",
    };
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
attachWebSocketProxy(server);
server.listen(port, host, () => console.log(`obsidian4web listening on http://localhost:${port}`));

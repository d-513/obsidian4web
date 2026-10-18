/// <reference lib="webworker" />
// Service worker: serves the Obsidian app (from the cached asar) at the origin root,
// mirroring Electron's app:// protocol, and serves vault files under /_vfs/ by asking
// the owning page (which holds the VFS in memory).

import { APP_CACHE, ASAR_KEY_PREFIX, CURRENT_KEY, OWN_PREFIX, VFS_PREFIX, mimeFor } from "../common/config";
import { indexFromBlob, type AsarIndex } from "../common/asar";

declare const self: ServiceWorkerGlobalScope;

const OWN_CACHE = "o4w-own";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// Asar access

interface LoadedApp {
  version: string;
  blob: Blob;
  index: AsarIndex;
}

let loaded: Promise<LoadedApp | null> | null = null;
let loadedVersion: string | null = null;

async function readCurrentVersion(): Promise<string | null> {
  const cache = await caches.open(APP_CACHE);
  const res = await cache.match(CURRENT_KEY);
  if (!res) return null;
  try {
    return ((await res.json()) as { version: string }).version;
  } catch {
    return null;
  }
}

async function loadApp(): Promise<LoadedApp | null> {
  const version = await readCurrentVersion();
  if (!version) return null;
  if (loaded && loadedVersion === version) return loaded;
  loadedVersion = version;
  loaded = (async () => {
    const cache = await caches.open(APP_CACHE);
    const res = await cache.match(ASAR_KEY_PREFIX + version);
    if (!res) return null;
    const blob = await res.blob();
    const index = await indexFromBlob(blob);
    return { version, blob, index };
  })().catch((e) => {
    console.error("[o4w-sw] failed to load asar", e);
    loaded = null;
    return null;
  });
  return loaded;
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "o4w-reload-app") {
    loaded = null;
    loadedVersion = null;
    event.waitUntil(
      loadApp().then((app) => {
        event.source?.postMessage({ type: "o4w-app-reloaded", version: app?.version ?? null });
      }),
    );
  }
});

// Files that are HTML entry points of the Obsidian app; we rewrite their script tags so
// the shim can finish async setup (mounting the vault) before Obsidian's code runs.
const HTML_ENTRY = /\.html?$/i;

function rewriteHtml(html: string, version: string): string {
  // Turn every <script src=...> into an inert tag that the shim will load in order.
  html = html.replace(/<script\b([^>]*)\bsrc=("[^"]*"|'[^']*')([^>]*)>\s*<\/script>/gi, (_m, a, src, b) => {
    const attrs = `${a} ${b}`.replace(/\btype=("[^"]*"|'[^']*')/i, "");
    return `<script type="o4w/deferred" data-src=${src}${attrs}></script>`;
  });
  const boot =
    `<script>window.__O4W_VERSION__=${JSON.stringify(version)};</script>` +
    `<link rel="stylesheet" href="${OWN_PREFIX}shim.css">` +
    `<link rel="manifest" href="/manifest.webmanifest">` +
    `<script src="${OWN_PREFIX}shim.js"></script>`;
  // Inject as the very first thing in <head>.
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${boot}`);
  return boot + html;
}

async function serveFromAsar(app: LoadedApp, path: string, request: Request): Promise<Response | null> {
  let entry = app.index.files.get(path);
  if (!entry && app.index.dirs.has(path.replace(/\/$/, ""))) {
    entry = app.index.files.get((path ? path.replace(/\/$/, "") + "/" : "") + "index.html");
    if (entry) path = (path ? path.replace(/\/$/, "") + "/" : "") + "index.html";
  }
  if (!entry) return null;
  const mime = mimeFor(path);
  const body = app.blob.slice(entry.offset, entry.offset + entry.size, mime);
  const headers: Record<string, string> = {
    "Content-Type": mime,
    "Cache-Control": "no-cache",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (HTML_ENTRY.test(path)) {
    const html = rewriteHtml(await body.text(), app.version);
    return new Response(html, { status: 200, headers });
  }
  return rangeResponse(request, body, headers);
}

async function rangeResponse(request: Request, body: Blob, headers: Record<string, string>): Promise<Response> {
  const range = request.headers.get("Range");
  headers["Accept-Ranges"] = "bytes";
  if (range) {
    const m = /^bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const size = body.size;
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : NaN;
      if (isNaN(start)) {
        // suffix range: last N bytes
        start = Math.max(0, size - (isNaN(end) ? 0 : end));
        end = size - 1;
      } else if (isNaN(end) || end >= size) {
        end = size - 1;
      }
      if (start > end || start >= size) {
        return new Response("Range Not Satisfiable", { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(body.slice(start, end + 1), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }
  }
  return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(body.size) } });
}

// ---------------------------------------------------------------------------
// Vault files: ask a page that has the path mounted.

interface VfsReply {
  ok: boolean;
  status: number;
  mounted?: boolean;
  data?: ArrayBuffer;
  size?: number;
  mtime?: number;
}

function askClient(client: Client, path: string, range: [number, number] | null): Promise<VfsReply> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve({ ok: false, status: 504, mounted: false }), 15000);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data as VfsReply);
    };
    client.postMessage({ type: "o4w-vfs-read", path, range }, [channel.port2]);
  });
}

async function serveVfs(event: FetchEvent, path: string): Promise<Response> {
  const request = event.request;
  const candidates: Client[] = [];
  const own = event.clientId ? await self.clients.get(event.clientId) : undefined;
  if (own && own.type === "window") candidates.push(own);
  for (const c of await self.clients.matchAll({ type: "window" })) {
    if (!candidates.some((x) => x.id === c.id)) candidates.push(c);
  }

  let range: [number, number] | null = null;
  const rangeHeader = request.headers.get("Range");
  const m = rangeHeader ? /^bytes=(\d+)-(\d*)/.exec(rangeHeader) : null;
  if (m) range = [Number(m[1]), m[2] ? Number(m[2]) : -1];

  for (const client of candidates) {
    const reply = await askClient(client, path, range);
    if (reply.mounted === false) continue;
    if (!reply.ok) return new Response("Not Found", { status: reply.status || 404 });
    const mime = mimeFor(path);
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    };
    if (reply.mtime) headers["Last-Modified"] = new Date(reply.mtime).toUTCString();
    const data = reply.data ?? new ArrayBuffer(0);
    if (range && reply.size !== undefined) {
      const start = range[0];
      const end = start + data.byteLength - 1;
      if (start >= reply.size) {
        return new Response("Range Not Satisfiable", { status: 416, headers: { "Content-Range": `bytes */${reply.size}` } });
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${reply.size}`;
      headers["Content-Length"] = String(data.byteLength);
      return new Response(data, { status: 206, headers });
    }
    headers["Content-Length"] = String(data.byteLength);
    return new Response(data, { status: 200, headers });
  }
  return new Response("Not Found", { status: 404 });
}

// ---------------------------------------------------------------------------
// Own assets (launcher + shim): network first, cache fallback for offline use.

async function networkFirst(request: Request): Promise<Response> {
  const cache = await caches.open(OWN_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && request.method === "GET") cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const hit = await cache.match(request, { ignoreSearch: request.mode === "navigate" });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET" && request.method !== "HEAD") return;

  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith(VFS_PREFIX)) {
    event.respondWith(serveVfs(event, pathname.slice(VFS_PREFIX.length - 1)));
    return;
  }
  // Proxy / dev-server internals pass straight through.
  if (
    pathname.startsWith("/__proxy") ||
    pathname.startsWith("/__wsproxy") ||
    pathname.startsWith("/@") ||
    pathname.startsWith("/node_modules/") ||
    pathname.startsWith("/src/")
  ) {
    return;
  }
  if (pathname === "/__o4w/asar-list") {
    event.respondWith(
      (async () => {
        const app = await loadApp();
        const prefix = url.searchParams.get("prefix") ?? "";
        const files = app ? [...app.index.files.keys()].filter((f) => f.startsWith(prefix)) : [];
        return new Response(JSON.stringify(files), { headers: { "Content-Type": "application/json" } });
      })(),
    );
    return;
  }
  if (pathname.startsWith(OWN_PREFIX) || pathname.startsWith("/assets/") || pathname === "/" || pathname === "/manifest.webmanifest" || pathname === "/o4w-icon.svg") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    (async () => {
      const app = await loadApp();
      if (app) {
        const res = await serveFromAsar(app, pathname.replace(/^\/+/, ""), request);
        if (res) return res;
      }
      return networkFirst(request);
    })(),
  );
});

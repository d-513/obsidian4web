// Shared constants between launcher, service worker and shim.

export const APP_CACHE = "o4w-app";
export const ASAR_KEY_PREFIX = "/__o4w/asar/";
export const CURRENT_KEY = "/__o4w/current";
/** Vault files are served by the service worker under this prefix (Obsidian's "file-url"). */
export const VFS_PREFIX = "/_vfs/";
/** Our own static assets (shim bundle etc.). */
export const OWN_PREFIX = "/o4w/";
export const PROXY_PREFIX = "/__proxy";
export const WS_PROXY_PREFIX = "/__wsproxy";
export const RELEASES_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json";

function ensureSlashes(p: string): string {
  if (!p.startsWith("/")) p = "/" + p;
  return p.endsWith("/") ? p : p + "/";
}

/**
 * Base URL pathname of this deployment (always starts and ends with "/", e.g. "/" or "/obsidian4web/app/").
 */
export function basePath(): string {
  const g = globalThis as {
    __O4W_BASE__?: string;
    registration?: { scope?: string };
    navigator?: { serviceWorker?: { controller?: { scriptURL?: string } | null } };
    location?: { href: string; pathname: string };
  };
  if (typeof g.__O4W_BASE__ === "string" && g.__O4W_BASE__) return ensureSlashes(g.__O4W_BASE__);
  if (g.registration?.scope) {
    try {
      return ensureSlashes(new URL(g.registration.scope).pathname);
    } catch {
      /* ignore */
    }
  }
  if (g.navigator?.serviceWorker?.controller?.scriptURL) {
    try {
      return ensureSlashes(new URL("./", g.navigator.serviceWorker.controller.scriptURL).pathname);
    } catch {
      /* ignore */
    }
  }
  if (g.location?.href) {
    try {
      return ensureSlashes(new URL("./", g.location.href).pathname);
    } catch {
      /* ignore */
    }
  }
  return "/";
}

export interface InstalledVersion {
  version: string;
  installedAt: number;
}

export const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  icns: "image/icns",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  ogv: "video/ogg",
  "3gp": "video/3gpp",
  canvas: "application/json; charset=utf-8",
  base: "text/plain; charset=utf-8",
};

export function mimeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  return MIME[ext] ?? "application/octet-stream";
}

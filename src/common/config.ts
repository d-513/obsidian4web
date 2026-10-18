// Shared constants between launcher, service worker and shim.

export const APP_CACHE = "o4w-app";
export const ASAR_KEY_PREFIX = "/__o4w/asar/";
export const CURRENT_KEY = "/__o4w/current";
/** Vault files are served by the service worker under this prefix (Obsidian's "file-url"). */
export const VFS_PREFIX = "/_vfs/";
/** Our own static assets (shim bundle etc.). */
export const OWN_PREFIX = "/o4w/";
export const PROXY_PREFIX = "/__proxy/";
export const WS_PROXY_PREFIX = "/__wsproxy/";
export const RELEASES_URL =
  "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json";

export interface InstalledVersion {
  version: string;
  installedAt: number;
}

/** Build a URL that goes through our CORS proxy. */
export function proxied(url: string): string {
  return PROXY_PREFIX + url;
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

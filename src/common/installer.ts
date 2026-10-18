// Downloads the official Obsidian release (asar) at runtime and stores it in Cache Storage.
// Nothing of Obsidian is redistributed by this project: the user's browser fetches it from
// Obsidian's own GitHub releases.

import { APP_CACHE, ASAR_KEY_PREFIX, CURRENT_KEY, RELEASES_URL, type InstalledVersion } from "./config";

export interface ReleaseInfo {
  latestVersion: string;
  minimumVersion?: string;
  downloadUrl: string;
  hash?: string;
}

function proxy(url: string): string {
  return "/__proxy?url=" + encodeURIComponent(url);
}

export async function fetchReleaseInfo(): Promise<ReleaseInfo> {
  let res: Response;
  try {
    res = await fetch(RELEASES_URL + "?t=" + Date.now(), { cache: "no-store" });
  } catch {
    res = await fetch(proxy(RELEASES_URL));
  }
  if (!res.ok) throw new Error(`Could not fetch release info (HTTP ${res.status})`);
  return (await res.json()) as ReleaseInfo;
}

export function releaseInfoForVersion(version: string): ReleaseInfo {
  return {
    latestVersion: version,
    downloadUrl: `https://github.com/obsidianmd/obsidian-releases/releases/download/v${version}/obsidian-${version}.asar.gz`,
  };
}

export async function getInstalled(): Promise<InstalledVersion | null> {
  const cache = await caches.open(APP_CACHE);
  const res = await cache.match(CURRENT_KEY);
  if (!res) return null;
  try {
    const cur = (await res.json()) as InstalledVersion;
    if (!(await cache.match(ASAR_KEY_PREFIX + cur.version))) return null;
    return cur;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function download(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(proxy(url));
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}): ${await res.text().catch(() => "")}`);
  const total = Number(res.headers.get("Content-Length") || res.headers.get("X-O4W-Content-Length") || 0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export type InstallPhase = "download" | "verify" | "extract" | "store" | "done";

export async function installRelease(
  info: ReleaseInfo,
  onProgress?: (phase: InstallPhase, loaded?: number, total?: number) => void,
): Promise<string> {
  const version = info.latestVersion;
  const gz = await download(info.downloadUrl, (l, t) => onProgress?.("download", l, t));

  onProgress?.("verify");
  if (info.hash) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", gz as BufferSource));
    if (toBase64(digest) !== info.hash) throw new Error("Integrity check failed: the downloaded file does not match the published hash.");
  }

  onProgress?.("extract");
  const asar = await new Response(new Blob([gz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).blob();
  // Sanity check: asar header starts with a 4-byte pickle size of 4.
  const head = new DataView(await asar.slice(0, 8).arrayBuffer());
  if (head.getUint32(0, true) !== 4) throw new Error("Downloaded file is not a valid asar archive.");

  onProgress?.("store");
  const cache = await caches.open(APP_CACHE);
  await cache.put(
    ASAR_KEY_PREFIX + version,
    new Response(asar, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(asar.size) } }),
  );
  const current: InstalledVersion = { version, installedAt: Date.now() };
  await cache.put(CURRENT_KEY, new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } }));
  // Remove other versions.
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith(ASAR_KEY_PREFIX) && p !== ASAR_KEY_PREFIX + version) await cache.delete(req);
  }
  onProgress?.("done");
  return version;
}

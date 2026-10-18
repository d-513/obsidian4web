// Installs the official Obsidian release (asar) into Cache Storage, either by downloading it
// through our proxy or from a file the user downloaded from Obsidian's GitHub releases.
// Nothing of Obsidian is redistributed by this project.

import { APP_CACHE, ASAR_KEY_PREFIX, CURRENT_KEY, RELEASES_URL, type InstalledVersion } from "./config";
import { indexFromBlob } from "./asar";
import { detectProxy, proxyAllows, proxyFetch } from "./proxy-client";

export interface ReleaseInfo {
  latestVersion: string;
  minimumVersion?: string;
  downloadUrl: string;
  /** Base64 SHA-256 of the .asar.gz, as published by Obsidian. */
  hash?: string;
}

export async function fetchReleaseInfo(): Promise<ReleaseInfo> {
  // raw.githubusercontent.com sends CORS headers, so no proxy is needed here.
  const res = await fetch(RELEASES_URL + "?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Could not fetch release info (HTTP ${res.status})`);
  return (await res.json()) as ReleaseInfo;
}

export function releasesPageUrl(version?: string): string {
  return version
    ? `https://github.com/obsidianmd/obsidian-releases/releases/tag/v${version}`
    : "https://github.com/obsidianmd/obsidian-releases/releases/latest";
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

/** Whether the app can be downloaded automatically (needs the proxy). */
export async function canAutoDownload(info: ReleaseInfo): Promise<boolean> {
  await detectProxy();
  return proxyAllows(info.downloadUrl);
}

async function download(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await proxyFetch(url);
  const status = Number(res.headers.get("X-O4W-Status") || res.status);
  if (status >= 400 || !res.body) throw new Error(`Download failed (HTTP ${status})`);
  const total = Number(res.headers.get("X-O4W-Content-Length") || res.headers.get("Content-Length") || 0);
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

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let s = "";
  for (let i = 0; i < digest.length; i++) s += String.fromCharCode(digest[i]);
  return btoa(s);
}

export type InstallPhase = "download" | "verify" | "extract" | "store" | "done";
type Progress = (phase: InstallPhase, loaded?: number, total?: number) => void;

export interface Inspection {
  /** Version read from the archive's own package.json. */
  version: string;
  /** "verified": matches Obsidian's published hash; "unverifiable": no hash to compare with. */
  integrity: "verified" | "unverifiable";
  asar: Blob;
}

const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b;

/**
 * Check and unpack an Obsidian release (.asar.gz or .asar). Throws if it does not match
 * the published hash for its version, or isn't an Obsidian app archive.
 */
export async function inspectRelease(bytes: Uint8Array, published?: ReleaseInfo | null, onProgress?: Progress): Promise<Inspection> {
  onProgress?.("verify");
  const gz = isGzip(bytes);
  const hash = gz ? await sha256Base64(bytes) : null;

  onProgress?.("extract");
  const asar = gz
    ? await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).blob()
    : new Blob([bytes as BlobPart]);
  const head = new DataView(await asar.slice(0, 8).arrayBuffer());
  if (asar.size < 16 || head.getUint32(0, true) !== 4) throw new Error("This is not an Obsidian app archive (.asar.gz).");
  let pkg: { name?: string; version?: string };
  try {
    const index = await indexFromBlob(asar);
    const entry = index.files.get("package.json");
    if (!entry || !index.files.has("app.js") || !index.files.has("index.html")) throw new Error();
    pkg = JSON.parse(await asar.slice(entry.offset, entry.offset + entry.size).text());
  } catch {
    throw new Error("This archive doesn't look like the Obsidian app.");
  }
  if (!pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) throw new Error("Could not determine the Obsidian version of this archive.");

  let integrity: Inspection["integrity"] = "unverifiable";
  if (published?.hash && published.latestVersion === pkg.version) {
    if (!hash) {
      // An unpacked .asar can't be compared against the published .asar.gz hash.
      integrity = "unverifiable";
    } else if (hash !== published.hash) {
      throw new Error(`Integrity check failed: this file does not match the official Obsidian ${pkg.version} release.`);
    } else {
      integrity = "verified";
    }
  }
  return { version: pkg.version, integrity, asar };
}

export async function storeRelease(inspection: Inspection, onProgress?: Progress): Promise<string> {
  onProgress?.("store");
  const { version, asar } = inspection;
  const cache = await caches.open(APP_CACHE);
  await cache.put(
    ASAR_KEY_PREFIX + version,
    new Response(asar, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(asar.size) } }),
  );
  const current: InstalledVersion = { version, installedAt: Date.now() };
  await cache.put(CURRENT_KEY, new Response(JSON.stringify(current), { headers: { "Content-Type": "application/json" } }));
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p.startsWith(ASAR_KEY_PREFIX) && p !== ASAR_KEY_PREFIX + version) await cache.delete(req);
  }
  onProgress?.("done");
  return version;
}

/** Download (through the proxy), verify and install. */
export async function installRelease(info: ReleaseInfo, onProgress?: Progress): Promise<string> {
  const gz = await download(info.downloadUrl, (l, t) => onProgress?.("download", l, t));
  if (!info.hash) throw new Error("No published hash to verify the download against.");
  const inspection = await inspectRelease(gz, info, onProgress);
  if (inspection.integrity !== "verified") throw new Error("Could not verify the downloaded file.");
  return storeRelease(inspection, onProgress);
}

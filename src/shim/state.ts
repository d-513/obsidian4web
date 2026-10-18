// Persistent state of the emulated Electron main process (Obsidian's obsidian.json),
// plus the registry of local folders granted through the File System Access API.

import { PATHS } from "./platform";

export interface VaultRecord {
  path: string;
  ts: number;
  open?: boolean;
}

export interface MainConfig {
  vaults: Record<string, VaultRecord>;
  language?: string;
  frame?: string;
  updateDisabled?: boolean;
  insider?: boolean;
  cli?: boolean;
  disableGpu?: boolean;
  adblock?: string[];
  adblockFrequency?: number;
  icon?: string;
  openSchemes?: Record<string, boolean>;
  termsAccepted?: boolean;
}

const KEY = "o4w-config";

export function loadConfig(): MainConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const c = JSON.parse(raw) as MainConfig;
      c.vaults ??= {};
      return c;
    }
  } catch {
    /* ignore */
  }
  return { vaults: {} };
}

export function saveConfig(c: MainConfig): void {
  localStorage.setItem(KEY, JSON.stringify(c));
}

export function updateConfig(fn: (c: MainConfig) => void): MainConfig {
  const c = loadConfig();
  fn(c);
  saveConfig(c);
  return c;
}

export function randomId(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len / 2));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Pending messages for windows that are about to open (Obsidian's OBS_ACT).

export function queueVaultAction(vaultId: string, action: unknown): void {
  const key = "o4w-act:" + vaultId;
  const list = JSON.parse(localStorage.getItem(key) || "[]") as unknown[];
  list.push(action);
  localStorage.setItem(key, JSON.stringify(list));
}

export function takeVaultActions(vaultId: string): unknown[] {
  const key = "o4w-act:" + vaultId;
  const list = JSON.parse(localStorage.getItem(key) || "[]") as unknown[];
  localStorage.removeItem(key);
  return list;
}

// ---------------------------------------------------------------------------
// Local folder handles (File System Access API), persisted in IndexedDB.

export interface FolderRecord {
  id: string;
  name: string;
  handle: FileSystemDirectoryHandle;
  addedAt: number;
}

function openMetaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("o4w-meta", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("folders", { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function listFolders(): Promise<FolderRecord[]> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("folders").objectStore("folders").getAll();
    r.onsuccess = () => resolve(r.result as FolderRecord[]);
    r.onerror = () => reject(r.error);
  });
}

export async function getFolder(id: string): Promise<FolderRecord | undefined> {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction("folders").objectStore("folders").get(id);
    r.onsuccess = () => resolve(r.result as FolderRecord | undefined);
    r.onerror = () => reject(r.error);
  });
}

export async function addFolder(handle: FileSystemDirectoryHandle): Promise<FolderRecord> {
  // Reuse an existing record for the same folder.
  for (const f of await listFolders()) {
    try {
      if (await f.handle.isSameEntry(handle)) return f;
    } catch {
      /* ignore */
    }
  }
  const rec: FolderRecord = { id: randomId(8), name: handle.name, handle, addedAt: Date.now() };
  const db = await openMetaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("folders", "readwrite");
    tx.objectStore("folders").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return rec;
}

export async function removeFolder(id: string): Promise<void> {
  const db = await openMetaDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("folders", "readwrite");
    tx.objectStore("folders").delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Mount root path for a folder record: /mnt/<id>/<folder name>. */
export function folderMountPath(rec: { id: string; name: string }): string {
  return `${PATHS.mnt}/${rec.id}/${rec.name}`;
}

/** If the path lives inside a local folder mount, returns the folder id. */
export function folderIdOf(path: string): string | null {
  const m = new RegExp("^" + PATHS.mnt + "/([^/]+)/").exec(path + "/");
  return m ? m[1] : null;
}

export const supportsFsa = typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

// IndexedDB persistence backend. Metadata and content live in separate object stores so
// the full tree can be scanned quickly at startup. Changes are broadcast to other tabs.

import type { Backend, ExternalChange, Meta, ScanEntry } from "./backend";

interface MetaRecord extends Meta {
  type: "file" | "dir";
  size: number;
}

const DB_NAME = "o4w-fs";
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
export function openFsDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => console.warn("[o4w-idb] open blocked");
    });
  }
  return dbPromise;
}

function subtreeRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix + "/", prefix + "/￿");
}

export class IdbBackend implements Backend {
  readonly kind = "idb";
  readonly persistent = true;
  /** Key prefix inside the database; the mount's root. "" means the database root. */
  private readonly prefix: string;
  private channel: BroadcastChannel | null = null;
  private readonly tabId = Math.random().toString(36).slice(2);

  constructor(prefix = "") {
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
  }

  private key(path: string): string {
    if (!this.prefix) return path;
    return path ? this.prefix + "/" + path : this.prefix;
  }

  private unkey(key: string): string | null {
    if (!this.prefix) return key;
    if (key === this.prefix) return "";
    if (key.startsWith(this.prefix + "/")) return key.slice(this.prefix.length + 1);
    return null;
  }

  private broadcast(changes: ExternalChange[]): void {
    try {
      this.channel ??= new BroadcastChannel("o4w-fs:" + this.prefix);
      this.channel.postMessage({ from: this.tabId, changes });
    } catch {
      /* BroadcastChannel unavailable */
    }
  }

  async scan(): Promise<ScanEntry[]> {
    const db = await openFsDb();
    const tx = db.transaction("meta", "readonly");
    const store = tx.objectStore("meta");
    const range = this.prefix ? IDBKeyRange.bound(this.prefix, this.prefix + "/￿") : undefined;
    const [keys, values] = await Promise.all([
      req(store.getAllKeys(range)) as Promise<string[]>,
      req(store.getAll(range)) as Promise<MetaRecord[]>,
    ]);
    const out: ScanEntry[] = [];
    for (let i = 0; i < keys.length; i++) {
      const rel = this.unkey(keys[i]);
      if (rel === null) continue;
      out.push({ path: rel, ...values[i] });
    }
    return out;
  }

  async read(path: string): Promise<Uint8Array> {
    const db = await openFsDb();
    const tx = db.transaction("data", "readonly");
    const value = (await req(tx.objectStore("data").get(this.key(path)))) as Uint8Array | ArrayBuffer | Blob | undefined;
    if (value === undefined) return new Uint8Array(0);
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(await (value as Blob).arrayBuffer());
  }

  async write(path: string, data: Uint8Array, meta: Meta): Promise<void> {
    const db = await openFsDb();
    const tx = db.transaction(["meta", "data"], "readwrite");
    const rec: MetaRecord = { type: "file", size: data.byteLength, ...meta };
    tx.objectStore("meta").put(rec, this.key(path));
    // Store a compact copy (the view may be into a larger buffer).
    const copy = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
    tx.objectStore("data").put(copy, this.key(path));
    await txDone(tx);
    this.broadcast([{ kind: "upsert", entry: { path, ...rec } }]);
  }

  async mkdir(path: string, meta: Meta): Promise<void> {
    const db = await openFsDb();
    const tx = db.transaction("meta", "readwrite");
    const rec: MetaRecord = { type: "dir", size: 0, ...meta };
    tx.objectStore("meta").put(rec, this.key(path));
    await txDone(tx);
    this.broadcast([{ kind: "upsert", entry: { path, ...rec } }]);
  }

  async remove(path: string, type: "file" | "dir"): Promise<void> {
    const db = await openFsDb();
    const tx = db.transaction(["meta", "data"], "readwrite");
    const k = this.key(path);
    tx.objectStore("meta").delete(k);
    if (type === "file") tx.objectStore("data").delete(k);
    else {
      tx.objectStore("meta").delete(subtreeRange(k));
      tx.objectStore("data").delete(subtreeRange(k));
    }
    await txDone(tx);
    this.broadcast([{ kind: "delete", path }]);
  }

  async rename(from: string, to: string, type: "file" | "dir"): Promise<void> {
    const db = await openFsDb();
    const tx = db.transaction(["meta", "data"], "readwrite");
    const metaStore = tx.objectStore("meta");
    const dataStore = tx.objectStore("data");
    const kFrom = this.key(from);
    const kTo = this.key(to);
    const moved: ScanEntry[] = [];

    const moveOne = async (src: string, dst: string) => {
      const m = (await req(metaStore.get(src))) as MetaRecord | undefined;
      if (!m) return;
      metaStore.delete(src);
      metaStore.put(m, dst);
      if (m.type === "file") {
        const d = await req(dataStore.get(src));
        dataStore.delete(src);
        if (d !== undefined) dataStore.put(d, dst);
      }
      const rel = this.unkey(dst);
      if (rel !== null) moved.push({ path: rel, ...m });
    };

    // Destination subtree is replaced.
    metaStore.delete(kTo);
    dataStore.delete(kTo);
    if (type === "dir") {
      metaStore.delete(subtreeRange(kTo));
      dataStore.delete(subtreeRange(kTo));
    }
    await moveOne(kFrom, kTo);
    if (type === "dir") {
      const keys = (await req(metaStore.getAllKeys(subtreeRange(kFrom)))) as string[];
      for (const k of keys) await moveOne(k, kTo + k.slice(kFrom.length));
    }
    await txDone(tx);
    moved.sort((a, b) => a.path.length - b.path.length);
    this.broadcast([{ kind: "delete", path: from }, ...moved.map((entry) => ({ kind: "upsert" as const, entry }))]);
  }

  async setMeta(path: string, meta: Meta, type: "file" | "dir"): Promise<void> {
    const db = await openFsDb();
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    const k = this.key(path);
    const old = ((await req(store.get(k))) as MetaRecord | undefined) ?? { type, size: 0, ...meta };
    const rec = { ...old, ...meta };
    store.put(rec, k);
    await txDone(tx);
    this.broadcast([{ kind: "upsert", entry: { path, ...rec } }]);
  }

  watchExternal(cb: (changes: ExternalChange[]) => void): () => void {
    let ch: BroadcastChannel;
    try {
      ch = new BroadcastChannel("o4w-fs:" + this.prefix);
    } catch {
      return () => {};
    }
    ch.onmessage = (e) => {
      const msg = e.data as { from: string; changes: ExternalChange[] };
      if (msg.from === this.tabId) return;
      cb(msg.changes);
    };
    return () => ch.close();
  }
}

/** Delete everything under a path prefix (used when removing a vault). */
export async function idbDeleteTree(prefix: string): Promise<void> {
  prefix = prefix.replace(/^\/+|\/+$/g, "");
  const db = await openFsDb();
  const tx = db.transaction(["meta", "data"], "readwrite");
  for (const s of ["meta", "data"]) {
    tx.objectStore(s).delete(prefix);
    tx.objectStore(s).delete(subtreeRange(prefix));
  }
  await txDone(tx);
}

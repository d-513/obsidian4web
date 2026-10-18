// File System Access API backend: a real folder on the user's disk (Chromium browsers).

import type { Backend, ExternalChange, Meta, ScanEntry } from "./backend";

/** Directories whose contents we do not mirror (huge and irrelevant to Obsidian). */
const SKIP_DIRS = new Set([".git", "node_modules", ".trash-cache"]);

interface Seen {
  size: number;
  lastModified: number;
  type: "file" | "dir";
}

type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
};

type MovableHandle = FileSystemHandle & {
  move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void>;
};

export class FsaBackend implements Backend {
  readonly kind = "fsa";
  readonly persistent = true;
  private dirs = new Map<string, FileSystemDirectoryHandle>();
  private seen = new Map<string, Seen>();
  private busy = 0;
  private listeners = new Set<(c: ExternalChange[]) => void>();

  constructor(readonly root: FileSystemDirectoryHandle) {
    this.dirs.set("", root);
  }

  static async ensurePermission(handle: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
    const h = handle as FileSystemDirectoryHandle & {
      queryPermission?(d: { mode: string }): Promise<PermissionState>;
      requestPermission?(d: { mode: string }): Promise<PermissionState>;
    };
    if (!h.queryPermission) return true;
    if ((await h.queryPermission({ mode: "readwrite" })) === "granted") return true;
    if (!request || !h.requestPermission) return false;
    return (await h.requestPermission({ mode: "readwrite" })) === "granted";
  }

  private async dir(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    const cached = this.dirs.get(path);
    if (cached) return cached;
    const idx = path.lastIndexOf("/");
    const parent = await this.dir(idx < 0 ? "" : path.slice(0, idx), create);
    const handle = await parent.getDirectoryHandle(path.slice(idx + 1), { create });
    this.dirs.set(path, handle);
    return handle;
  }

  private async parentOf(path: string, create = false): Promise<[FileSystemDirectoryHandle, string]> {
    const idx = path.lastIndexOf("/");
    return [await this.dir(idx < 0 ? "" : path.slice(0, idx), create), path.slice(idx + 1)];
  }

  private async fileHandle(path: string, create = false): Promise<FileSystemFileHandle> {
    const [parent, name] = await this.parentOf(path, create);
    return parent.getFileHandle(name, { create });
  }

  private forgetDirs(prefix: string): void {
    for (const k of [...this.dirs.keys()]) {
      if (k === prefix || k.startsWith(prefix + "/")) this.dirs.delete(k);
    }
  }

  private async walk(): Promise<ScanEntry[]> {
    const out: ScanEntry[] = [];
    const visit = async (handle: FileSystemDirectoryHandle, prefix: string) => {
      const tasks: Promise<void>[] = [];
      for await (const [name, child] of (handle as DirHandle).entries()) {
        const p = prefix ? prefix + "/" + name : name;
        if (child.kind === "directory") {
          this.dirs.set(p, child as FileSystemDirectoryHandle);
          out.push({ path: p, type: "dir", size: 0, mtime: 0, ctime: 0, birthtime: 0 });
          if (!SKIP_DIRS.has(name)) tasks.push(visit(child as FileSystemDirectoryHandle, p));
        } else {
          tasks.push(
            (child as FileSystemFileHandle).getFile().then(
              (f) => {
                const t = f.lastModified;
                out.push({ path: p, type: "file", size: f.size, mtime: t, ctime: t, birthtime: t });
              },
              () => {},
            ),
          );
        }
      }
      await Promise.all(tasks);
    };
    await visit(this.root, "");
    // Directories carry no timestamps through this API; use the newest child time.
    const latest = new Map<string, number>();
    for (const e of out) {
      if (e.type !== "file") continue;
      let p = e.path;
      while (p.includes("/")) {
        p = p.slice(0, p.lastIndexOf("/"));
        if ((latest.get(p) ?? 0) < e.mtime) latest.set(p, e.mtime);
      }
    }
    const fallback = Date.now();
    for (const e of out) {
      if (e.type === "dir") e.mtime = e.ctime = e.birthtime = latest.get(e.path) ?? fallback;
    }
    return out;
  }

  async scan(): Promise<ScanEntry[]> {
    const entries = await this.walk();
    this.seen.clear();
    for (const e of entries) this.seen.set(e.path, { size: e.size, lastModified: e.mtime, type: e.type });
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    const file = await (await this.fileHandle(path)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readRange(path: string, start: number, end: number): Promise<Uint8Array> {
    const file = await (await this.fileHandle(path)).getFile();
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  }

  async write(path: string, data: Uint8Array, _meta: Meta): Promise<void> {
    this.busy++;
    try {
      const handle = await this.fileHandle(path, true);
      const w = await handle.createWritable();
      await w.write(data as unknown as BufferSource);
      await w.close();
      const f = await handle.getFile();
      this.seen.set(path, { size: f.size, lastModified: f.lastModified, type: "file" });
    } finally {
      this.busy--;
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.dir(path, true);
    this.seen.set(path, { size: 0, lastModified: Date.now(), type: "dir" });
  }

  async remove(path: string, type: "file" | "dir"): Promise<void> {
    this.busy++;
    try {
      const [parent, name] = await this.parentOf(path);
      try {
        await parent.removeEntry(name, { recursive: type === "dir" });
      } catch (e) {
        if ((e as DOMException).name !== "NotFoundError") throw e;
      }
      this.forgetDirs(path);
      for (const k of [...this.seen.keys()]) if (k === path || k.startsWith(path + "/")) this.seen.delete(k);
    } finally {
      this.busy--;
    }
  }

  async rename(from: string, to: string, type: "file" | "dir"): Promise<void> {
    this.busy++;
    try {
      const [srcParent, srcName] = await this.parentOf(from);
      const [dstParent, dstName] = await this.parentOf(to, true);
      const handle: MovableHandle =
        type === "file" ? await srcParent.getFileHandle(srcName) : await srcParent.getDirectoryHandle(srcName);
      let moved = false;
      if (typeof handle.move === "function") {
        try {
          await handle.move(dstParent, dstName);
          moved = true;
        } catch (e) {
          console.warn("[o4w-fsa] native move failed, copying instead", e);
        }
      }
      if (!moved) {
        await this.copyTree(handle as FileSystemHandle, dstParent, dstName);
        await srcParent.removeEntry(srcName, { recursive: type === "dir" });
      }
      this.forgetDirs(from);
      this.forgetDirs(to);
      for (const k of [...this.seen.keys()]) {
        if (k === from || k.startsWith(from + "/")) {
          const v = this.seen.get(k)!;
          this.seen.delete(k);
          this.seen.set(to + k.slice(from.length), v);
        }
      }
    } finally {
      this.busy--;
    }
  }

  private async copyTree(src: FileSystemHandle, dstParent: FileSystemDirectoryHandle, name: string): Promise<void> {
    if (src.kind === "file") {
      const file = await (src as FileSystemFileHandle).getFile();
      const out = await dstParent.getFileHandle(name, { create: true });
      const w = await out.createWritable();
      await w.write(file);
      await w.close();
      return;
    }
    const dir = await dstParent.getDirectoryHandle(name, { create: true });
    for await (const [childName, child] of (src as DirHandle).entries()) {
      await this.copyTree(child, dir, childName);
    }
  }

  async setMeta(): Promise<void> {
    // The File System Access API cannot set timestamps.
  }

  watchExternal(cb: (changes: ExternalChange[]) => void): () => void {
    this.listeners.add(cb);
    let observer: { observe(h: FileSystemHandle, o: object): Promise<void>; disconnect(): void } | null = null;
    const Observer = (globalThis as unknown as { FileSystemObserver?: new (cb: () => void) => typeof observer })
      .FileSystemObserver;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void this.poll();
      }, 300);
    };
    if (Observer) {
      try {
        observer = new Observer(schedule);
        observer!.observe(this.root, { recursive: true }).catch(() => {
          observer = null;
        });
      } catch {
        observer = null;
      }
    }
    const onFocus = () => schedule();
    window.addEventListener("focus", onFocus);
    const interval = setInterval(() => {
      if (!observer && document.visibilityState === "visible") schedule();
    }, 10000);
    return () => {
      this.listeners.delete(cb);
      observer?.disconnect();
      window.removeEventListener("focus", onFocus);
      clearInterval(interval);
    };
  }

  private polling = false;
  async poll(): Promise<void> {
    if (this.polling || this.busy > 0) return;
    this.polling = true;
    try {
      const entries = await this.walk();
      if (this.busy > 0) return;
      const changes: ExternalChange[] = [];
      const present = new Set<string>();
      for (const e of entries) {
        present.add(e.path);
        const old = this.seen.get(e.path);
        if (!old || old.type !== e.type || (e.type === "file" && (old.size !== e.size || old.lastModified !== e.mtime))) {
          changes.push({ kind: "upsert", entry: e });
        }
        this.seen.set(e.path, { size: e.size, lastModified: e.mtime, type: e.type });
      }
      for (const k of [...this.seen.keys()]) {
        if (!present.has(k)) {
          this.seen.delete(k);
          // Only report the top-most deleted path.
          const parent = k.includes("/") ? k.slice(0, k.lastIndexOf("/")) : "";
          if (!parent || present.has(parent)) changes.push({ kind: "delete", path: k });
        }
      }
      if (changes.length) {
        changes.sort((a, b) => (a.kind === "upsert" ? a.entry.path.length : 0) - (b.kind === "upsert" ? b.entry.path.length : 0));
        for (const l of this.listeners) l(changes);
      }
    } catch (e) {
      console.warn("[o4w-fsa] poll failed", e);
    } finally {
      this.polling = false;
    }
  }
}

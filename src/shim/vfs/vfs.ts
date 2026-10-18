// In-memory virtual filesystem with pluggable async persistence.
//
// The whole tree (metadata) lives in memory so that Node's synchronous APIs work.
// File contents are cached lazily. Every mutation is applied to memory immediately and
// queued for persistence on the owning mount's backend, in order.

import type { Backend, ExternalChange, Meta, ScanEntry } from "./backend";
import { fsError } from "./errors";

export type NodeType = "file" | "dir";

export interface VNode {
  type: NodeType;
  name: string;
  parent: VNode | null;
  ino: number;
  mode: number;
  size: number;
  mtime: number;
  ctime: number;
  birthtime: number;
  atime: number;
  /** File content, if cached in memory. */
  data?: Uint8Array;
  /** Number of pending persistence writes; content must stay cached while > 0. */
  dirty?: number;
  /** Lazy content source (e.g. a dropped File), consumed on first read. */
  loader?: () => Promise<Uint8Array>;
  children?: Map<string, VNode>;
  /** Set on a mount root. */
  mount?: Mount;
}

export interface Mount {
  path: string; // absolute, normalized
  backend: Backend;
  root: VNode;
  queue: Promise<void>;
  pending: number;
  unwatch?: () => void;
}

export type WatchEvent = "rename" | "change";
type WatchListener = (event: WatchEvent, path: string) => void;

interface Watcher {
  path: string;
  recursive: boolean;
  listener: WatchListener;
}

const MAX_CACHE = 4 * 1024 * 1024;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

let inoCounter = 1000;

function now(): number {
  return Date.now();
}

export function normalize(p: string): string {
  if (!p) return "/";
  if (!p.startsWith("/")) p = "/" + p;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return "/" + parts.join("/");
}

function split(p: string): string[] {
  return p === "/" ? [] : p.slice(1).split("/");
}

function makeNode(type: NodeType, name: string, parent: VNode | null, meta?: Partial<Meta>): VNode {
  const t = now();
  const node: VNode = {
    type,
    name,
    parent,
    ino: ++inoCounter,
    mode: meta?.mode ?? (type === "dir" ? S_IFDIR | 0o755 : S_IFREG | 0o644),
    size: 0,
    mtime: meta?.mtime ?? t,
    ctime: meta?.ctime ?? t,
    birthtime: meta?.birthtime ?? meta?.ctime ?? t,
    atime: meta?.mtime ?? t,
  };
  if (type === "dir") node.children = new Map();
  return node;
}

export function pathOf(node: VNode): string {
  const parts: string[] = [];
  for (let n: VNode | null = node; n && n.parent; n = n.parent) parts.push(n.name);
  return "/" + parts.reverse().join("/");
}

export class VFS {
  readonly root: VNode = makeNode("dir", "", null);
  private mounts: Mount[] = [];
  private watchers = new Set<Watcher>();
  /** Listeners notified after every successful mutation (used for cross-tab sync). */
  onPersisted: ((mount: Mount, change: ExternalChange) => void) | null = null;

  // -------------------------------------------------------------------------
  // Mounting

  async mount(path: string, backend: Backend): Promise<Mount> {
    path = normalize(path);
    const existing = this.mounts.find((m) => m.path === path);
    if (existing) return existing;
    const root = this.mkdirpMemory(path);
    root.children = new Map();
    const mount: Mount = { path, backend, root, queue: Promise.resolve(), pending: 0 };
    root.mount = mount;
    this.mounts.push(mount);
    this.mounts.sort((a, b) => b.path.length - a.path.length);
    const entries = await backend.scan();
    // Parents before children.
    entries.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    for (const e of entries) this.applyScanEntry(mount, e);
    if (backend.watchExternal) {
      mount.unwatch = backend.watchExternal((changes) => this.applyExternal(mount, changes));
    }
    return mount;
  }

  unmount(path: string): void {
    path = normalize(path);
    const idx = this.mounts.findIndex((m) => m.path === path);
    if (idx < 0) return;
    const m = this.mounts[idx];
    m.unwatch?.();
    this.mounts.splice(idx, 1);
    const parent = m.root.parent;
    parent?.children?.delete(m.root.name);
  }

  getMounts(): readonly Mount[] {
    return this.mounts;
  }

  isMounted(path: string): boolean {
    return this.mountOf(normalize(path)) !== null;
  }

  /** Returns the innermost mount containing the absolute path. */
  mountOf(path: string): Mount | null {
    for (const m of this.mounts) {
      if (path === m.path || path.startsWith(m.path === "/" ? "/" : m.path + "/")) return m;
    }
    return null;
  }

  private relPath(mount: Mount, path: string): string {
    if (path === mount.path) return "";
    return mount.path === "/" ? path.slice(1) : path.slice(mount.path.length + 1);
  }

  private mkdirpMemory(path: string): VNode {
    let node = this.root;
    for (const seg of split(path)) {
      let child = node.children!.get(seg);
      if (!child) {
        child = makeNode("dir", seg, node);
        node.children!.set(seg, child);
      }
      node = child;
    }
    return node;
  }

  private applyScanEntry(mount: Mount, e: ScanEntry): void {
    if (!e.path) {
      mount.root.mtime = e.mtime;
      mount.root.ctime = e.ctime;
      mount.root.birthtime = e.birthtime;
      return;
    }
    const segs = e.path.split("/");
    let node = mount.root;
    for (let i = 0; i < segs.length - 1; i++) {
      let child = node.children!.get(segs[i]);
      if (!child) {
        child = makeNode("dir", segs[i], node);
        node.children!.set(segs[i], child);
      }
      if (child.type !== "dir") return;
      node = child;
    }
    const name = segs[segs.length - 1];
    let target = node.children!.get(name);
    if (target && target.type !== e.type) {
      node.children!.delete(name);
      target = undefined;
    }
    if (!target) {
      target = makeNode(e.type, name, node, e);
      node.children!.set(name, target);
    }
    target.mtime = e.mtime;
    target.ctime = e.ctime;
    target.birthtime = e.birthtime;
    if (e.mode) target.mode = e.mode;
    if (e.type === "file") {
      target.size = e.size;
      if (e.data) target.data = e.data;
      else if (!target.dirty) target.data = undefined;
    }
  }

  private applyExternal(mount: Mount, changes: ExternalChange[]): void {
    for (const c of changes) {
      if (c.kind === "upsert") {
        const abs = mount.path === "/" ? "/" + c.entry.path : mount.path + "/" + c.entry.path;
        const existed = this.lookup(abs);
        const mountOfPath = this.mountOf(normalize(abs));
        if (mountOfPath !== mount) continue; // shadowed by an inner mount
        if (existed?.dirty) continue; // we have newer local content
        this.applyScanEntry(mount, c.entry);
        this.emit(abs, existed ? "change" : "rename");
      } else {
        const abs = mount.path === "/" ? "/" + c.path : mount.path + "/" + c.path;
        const node = this.lookup(abs);
        if (!node || node.mount || node.dirty) continue;
        node.parent?.children?.delete(node.name);
        this.emit(abs, "rename");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Persistence queue

  private enqueue(mount: Mount, op: () => Promise<void>, change?: ExternalChange): Promise<void> {
    mount.pending++;
    const run = mount.queue.then(op);
    mount.queue = run
      .then(
        () => {
          if (change) this.onPersisted?.(mount, change);
        },
        (e) => {
          console.error("[o4w-vfs] persistence error on", mount.path, e);
        },
      )
      .finally(() => {
        mount.pending--;
      });
    // Errors propagate to async callers; sync callers ignore the promise.
    run.catch(() => {});
    return run;
  }

  /** Resolves when all queued persistence operations are done. */
  async flush(): Promise<void> {
    await Promise.all(this.mounts.map((m) => m.queue));
  }

  pendingWrites(): number {
    return this.mounts.reduce((n, m) => n + (m.backend.persistent ? m.pending : 0), 0);
  }

  // -------------------------------------------------------------------------
  // Watching

  watch(path: string, recursive: boolean, listener: WatchListener): () => void {
    const w: Watcher = { path: normalize(path), recursive, listener };
    this.watchers.add(w);
    return () => this.watchers.delete(w);
  }

  emit(path: string, event: WatchEvent): void {
    if (this.watchers.size === 0) return;
    const fire = () => {
      for (const w of this.watchers) {
        if (path === w.path) {
          w.listener(event, path.slice(path.lastIndexOf("/") + 1));
        } else if (w.path === "/" || path.startsWith(w.path + "/")) {
          const rel = w.path === "/" ? path.slice(1) : path.slice(w.path.length + 1);
          if (w.recursive || !rel.includes("/")) w.listener(event, rel);
        }
      }
    };
    setTimeout(fire, 0);
  }

  // -------------------------------------------------------------------------
  // Lookup helpers

  lookup(path: string): VNode | null {
    let node = this.root;
    for (const seg of split(normalize(path))) {
      if (node.type !== "dir") return null;
      const child = node.children!.get(seg);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  private resolve(path: string, syscall: string): VNode {
    let node = this.root;
    for (const seg of split(normalize(path))) {
      if (node.type !== "dir") throw fsError("ENOTDIR", syscall, path);
      const child = node.children!.get(seg);
      if (!child) throw fsError("ENOENT", syscall, path);
      node = child;
    }
    return node;
  }

  private resolveParent(path: string, syscall: string): { parent: VNode; name: string; abs: string } {
    const abs = normalize(path);
    if (abs === "/") throw fsError("EPERM", syscall, path);
    const idx = abs.lastIndexOf("/");
    const parentPath = abs.slice(0, idx) || "/";
    const name = abs.slice(idx + 1);
    const parent = this.resolve(parentPath, syscall);
    if (parent.type !== "dir") throw fsError("ENOTDIR", syscall, path);
    return { parent, name, abs };
  }

  private metaOf(node: VNode): Meta {
    return { mtime: node.mtime, ctime: node.ctime, birthtime: node.birthtime, mode: node.mode };
  }

  // -------------------------------------------------------------------------
  // Operations (synchronous, memory-first)

  exists(path: string): boolean {
    return this.lookup(path) !== null;
  }

  stat(path: string, syscall = "stat"): VNode {
    return this.resolve(path, syscall);
  }

  readdir(path: string): string[] {
    const node = this.resolve(path, "scandir");
    if (node.type !== "dir") throw fsError("ENOTDIR", "scandir", path);
    return [...node.children!.keys()];
  }

  readdirNodes(path: string): VNode[] {
    const node = this.resolve(path, "scandir");
    if (node.type !== "dir") throw fsError("ENOTDIR", "scandir", path);
    return [...node.children!.values()];
  }

  /** Synchronous read. Throws EAGAIN if the content is not cached. */
  readSync(path: string): Uint8Array {
    const node = this.resolve(path, "open");
    if (node.type === "dir") throw fsError("EISDIR", "read", path);
    if (node.data) return node.data;
    const mount = this.mountOf(normalize(path));
    if (!mount || !mount.backend.persistent || node.size === 0) return (node.data = new Uint8Array(0));
    throw fsError(
      "EAGAIN",
      "open",
      path,
      undefined,
      "file content not loaded yet (synchronous read in browser); use async fs APIs",
    );
  }

  async read(path: string): Promise<Uint8Array> {
    const abs = normalize(path);
    const node = this.resolve(abs, "open");
    if (node.type === "dir") throw fsError("EISDIR", "read", path);
    if (node.data) return node.data;
    if (node.loader) {
      const loader = node.loader;
      const data = await loader();
      if (node.loader === loader) {
        node.loader = undefined;
        node.data = data;
        node.size = data.byteLength;
      }
      return data;
    }
    const mount = this.mountOf(abs)!;
    if (!mount.backend.persistent) return (node.data = new Uint8Array(0));
    // Wait for queued writes so we don't read stale data.
    await mount.queue;
    if (node.data) return node.data;
    let data: Uint8Array;
    try {
      data = await mount.backend.read(this.relPath(mount, abs));
    } catch (e) {
      if (!this.lookup(abs)) throw fsError("ENOENT", "open", path);
      throw e;
    }
    node.size = data.byteLength;
    if (data.byteLength <= MAX_CACHE) node.data = data;
    return data;
  }

  async readRange(path: string, start: number, end: number): Promise<{ data: Uint8Array; size: number }> {
    const abs = normalize(path);
    const node = this.resolve(abs, "open");
    if (node.type === "dir") throw fsError("EISDIR", "read", path);
    const size = node.size;
    if (end < 0 || end >= size) end = size - 1;
    if (!node.data) {
      const mount = this.mountOf(abs)!;
      if (mount.backend.readRange && mount.backend.persistent) {
        await mount.queue;
        if (!node.data) {
          return { data: await mount.backend.readRange(this.relPath(mount, abs), start, end + 1), size };
        }
      }
    }
    const data = await this.read(abs);
    return { data: data.subarray(start, end + 1), size: data.byteLength };
  }

  /** Preload contents of all files under a directory (for sync access). */
  async preload(path: string, maxSize = 2 * 1024 * 1024): Promise<void> {
    const node = this.lookup(path);
    if (!node) return;
    const tasks: Promise<unknown>[] = [];
    const walk = (n: VNode, p: string) => {
      if (n.type === "dir") {
        for (const [name, c] of n.children!) walk(c, p + "/" + name);
      } else if (!n.data && n.size <= maxSize) {
        tasks.push(this.read(p).catch(() => {}));
      }
    };
    walk(node, normalize(path) === "/" ? "" : normalize(path));
    await Promise.all(tasks);
  }

  /** Create a file whose content is produced lazily (memory mounts only). */
  createLazyFile(path: string, size: number, mtime: number, loader: () => Promise<Uint8Array>): void {
    const { parent, name, abs } = this.resolveParent(path, "open");
    const node = makeNode("file", name, parent, { mtime, ctime: mtime, birthtime: mtime });
    node.size = size;
    node.loader = loader;
    parent.children!.set(name, node);
    this.emit(abs, "rename");
  }

  write(path: string, data: Uint8Array, opts?: { flag?: "w" | "a" | "wx"; mtime?: number }): Promise<void> {
    const { parent, name, abs } = this.resolveParent(path, "open");
    let node = parent.children!.get(name);
    const t = opts?.mtime ?? now();
    let created = false;
    if (node) {
      if (node.type === "dir") throw fsError("EISDIR", "open", path);
      if (opts?.flag === "wx") throw fsError("EEXIST", "open", path);
      if (opts?.flag === "a") {
        const old = node.data ?? this.readSync(abs);
        const merged = new Uint8Array(old.byteLength + data.byteLength);
        merged.set(old, 0);
        merged.set(data, old.byteLength);
        data = merged;
      }
    } else {
      node = makeNode("file", name, parent, { mtime: t, ctime: t, birthtime: t });
      parent.children!.set(name, node);
      parent.mtime = parent.ctime = t;
      created = true;
    }
    node.data = data;
    node.loader = undefined;
    node.size = data.byteLength;
    node.mtime = node.ctime = t;
    this.emit(abs, created ? "rename" : "change");
    return this.persistWrite(abs, node);
  }

  private persistWrite(abs: string, node: VNode): Promise<void> {
    const mount = this.mountOf(abs)!;
    const rel = this.relPath(mount, abs);
    const data = node.data!;
    const meta = this.metaOf(node);
    node.dirty = (node.dirty ?? 0) + 1;
    return this.enqueue(
      mount,
      async () => {
        try {
          // The file may have been renamed meanwhile; write to its current location.
          const current = node.parent ? pathOf(node) : null;
          if (current === null || this.lookup(current) !== node) return; // deleted
          const m2 = this.mountOf(current);
          if (m2 !== mount) return;
          await mount.backend.write(this.relPath(mount, current), data, meta);
        } finally {
          node.dirty!--;
          if (!node.dirty && node.size > MAX_CACHE && node.data === data) node.data = undefined;
        }
      },
      { kind: "upsert", entry: { path: rel, type: "file", size: data.byteLength, ...meta } },
    );
  }

  mkdir(path: string, recursive = false): string | undefined {
    const abs = normalize(path);
    if (recursive) {
      let first: string | undefined;
      let node = this.root;
      let cur = "";
      for (const seg of split(abs)) {
        cur += "/" + seg;
        let child = node.children!.get(seg);
        if (!child) {
          this.mkdir(cur, false);
          child = node.children!.get(seg)!;
          first ??= cur;
        } else if (child.type !== "dir") {
          throw fsError("ENOTDIR", "mkdir", path);
        }
        node = child;
      }
      return first;
    }
    const { parent, name } = this.resolveParent(abs, "mkdir");
    if (parent.children!.has(name)) throw fsError("EEXIST", "mkdir", path);
    const t = now();
    const node = makeNode("dir", name, parent, { mtime: t, ctime: t, birthtime: t });
    parent.children!.set(name, node);
    parent.mtime = parent.ctime = t;
    this.emit(abs, "rename");
    const mount = this.mountOf(abs)!;
    const rel = this.relPath(mount, abs);
    void this.enqueue(mount, () => mount.backend.mkdir(rel, this.metaOf(node)), {
      kind: "upsert",
      entry: { path: rel, type: "dir", size: 0, ...this.metaOf(node) },
    });
    return abs;
  }

  unlink(path: string): Promise<void> {
    const abs = normalize(path);
    const node = this.resolve(abs, "unlink");
    if (node.type === "dir") throw fsError("EPERM", "unlink", path, undefined, "operation not permitted");
    return this.removeNode(abs, node);
  }

  rmdir(path: string, recursive = false): Promise<void> {
    const abs = normalize(path);
    const node = this.resolve(abs, "rmdir");
    if (node.type !== "dir") throw fsError("ENOTDIR", "rmdir", path);
    if (node.mount || this.mounts.some((m) => m.path.startsWith(abs + "/"))) throw fsError("EBUSY", "rmdir", path);
    if (!recursive && node.children!.size > 0) throw fsError("ENOTEMPTY", "rmdir", path);
    return this.removeNode(abs, node);
  }

  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
    const abs = normalize(path);
    const node = this.lookup(abs);
    if (!node) {
      if (opts.force) return Promise.resolve();
      throw fsError("ENOENT", "rm", path);
    }
    if (node.type === "dir") {
      if (!opts.recursive) throw fsError("EISDIR", "rm", path, undefined, "Path is a directory");
      return this.rmdir(abs, true);
    }
    return this.removeNode(abs, node);
  }

  private removeNode(abs: string, node: VNode): Promise<void> {
    const parent = node.parent!;
    parent.children!.delete(node.name);
    parent.mtime = parent.ctime = now();
    // Emit for descendants first (like a recursive watcher would see).
    const emitTree = (n: VNode, p: string) => {
      if (n.type === "dir") for (const [name, c] of n.children!) emitTree(c, p + "/" + name);
      this.emit(p, "rename");
    };
    emitTree(node, abs);
    const mount = this.mountOf(abs)!;
    const rel = this.relPath(mount, abs);
    const type = node.type;
    // Collect subtree bottom-up for backends that need per-entry removal.
    const entries: { rel: string; type: NodeType }[] = [];
    const collect = (n: VNode, r: string) => {
      if (n.type === "dir") for (const [name, c] of n.children!) collect(c, r ? r + "/" + name : name);
      entries.push({ rel: r, type: n.type });
    };
    collect(node, rel);
    return this.enqueue(
      mount,
      async () => {
        if (type === "file") await mount.backend.remove(rel, "file");
        else for (const e of entries) await mount.backend.remove(e.rel, e.type);
      },
      { kind: "delete", path: rel },
    );
  }

  rename(from: string, to: string): Promise<void> {
    const src = normalize(from);
    const dst = normalize(to);
    const node = this.resolve(src, "rename");
    if (src === dst) return Promise.resolve();
    if (node.mount) throw fsError("EBUSY", "rename", from, to);
    if (dst.startsWith(src + "/")) throw fsError("EINVAL", "rename", from, to);
    const { parent: dstParent, name: dstName } = this.resolveParent(dst, "rename");
    const existing = dstParent.children!.get(dstName);
    if (existing) {
      if (existing === node) {
        // Case-only rename on the same node (cannot happen with case-sensitive maps).
      } else if (existing.type === "dir") {
        if (node.type !== "dir") throw fsError("EISDIR", "rename", from, to);
        if (existing.children!.size > 0) throw fsError("ENOTEMPTY", "rename", from, to);
      } else if (node.type === "dir") {
        throw fsError("ENOTDIR", "rename", from, to);
      }
    }
    const srcMount = this.mountOf(src)!;
    const dstMount = this.mountOf(dst)!;
    if (srcMount !== dstMount) {
      // Cross-mount: copy then delete.
      return this.crossMountMove(src, dst, node);
    }
    if (existing && existing !== node) {
      void this.removeNode(dst, existing);
    }
    const srcParent = node.parent!;
    srcParent.children!.delete(node.name);
    node.name = dstName;
    node.parent = dstParent;
    dstParent.children!.set(dstName, node);
    const t = now();
    srcParent.mtime = srcParent.ctime = t;
    dstParent.mtime = dstParent.ctime = t;
    node.ctime = t;
    this.emit(src, "rename");
    this.emit(dst, "rename");
    const relFrom = this.relPath(srcMount, src);
    const relTo = this.relPath(srcMount, dst);
    const type = node.type;
    return this.enqueue(srcMount, () => srcMount.backend.rename(relFrom, relTo, type), {
      kind: "delete",
      path: relFrom,
    }).then(() => {
      // Announce the new location to other tabs.
      this.onPersisted?.(srcMount, {
        kind: "upsert",
        entry: { path: relTo, type, size: node.size, ...this.metaOf(node) },
      });
    });
  }

  private async crossMountMove(src: string, dst: string, node: VNode): Promise<void> {
    await this.copyRecursive(src, dst);
    if (node.type === "dir") await this.rmdir(src, true);
    else await this.unlink(src);
  }

  async copyRecursive(src: string, dst: string): Promise<void> {
    const node = this.resolve(src, "copyfile");
    if (node.type === "file") {
      const data = await this.read(src);
      await this.write(dst, data.slice(), { mtime: node.mtime });
      return;
    }
    if (!this.exists(dst)) this.mkdir(dst);
    for (const name of [...node.children!.keys()]) {
      await this.copyRecursive(src + "/" + name, dst + "/" + name);
    }
  }

  async copyFile(src: string, dst: string, exclusive = false): Promise<void> {
    const node = this.resolve(src, "copyfile");
    if (node.type === "dir") throw fsError("EISDIR", "copyfile", src, dst);
    if (exclusive && this.exists(dst)) throw fsError("EEXIST", "copyfile", src, dst);
    const data = await this.read(src);
    await this.write(dst, data.slice());
  }

  copyFileSync(src: string, dst: string, exclusive = false): void {
    const node = this.resolve(src, "copyfile");
    if (node.type === "dir") throw fsError("EISDIR", "copyfile", src, dst);
    if (exclusive && this.exists(dst)) throw fsError("EEXIST", "copyfile", src, dst);
    void this.write(dst, this.readSync(src).slice());
  }

  utimes(path: string, atime: number, mtime: number): Promise<void> {
    const abs = normalize(path);
    const node = this.resolve(abs, "utime");
    node.atime = atime;
    node.mtime = mtime;
    return this.persistMeta(abs, node);
  }

  setBirthtime(path: string, birthtime: number): Promise<void> {
    const abs = normalize(path);
    const node = this.resolve(abs, "utime");
    node.birthtime = birthtime;
    return this.persistMeta(abs, node);
  }

  private persistMeta(abs: string, node: VNode): Promise<void> {
    const mount = this.mountOf(abs)!;
    const rel = this.relPath(mount, abs);
    const meta = this.metaOf(node);
    return this.enqueue(mount, () => mount.backend.setMeta(rel, meta, node.type), {
      kind: "upsert",
      entry: { path: rel, type: node.type, size: node.size, ...meta },
    });
  }

  truncate(path: string, len = 0): Promise<void> {
    const abs = normalize(path);
    const node = this.resolve(abs, "open");
    const data = node.data ?? this.readSync(abs);
    const out = new Uint8Array(len);
    out.set(data.subarray(0, len));
    return this.write(abs, out);
  }
}

export const vfs = new VFS();

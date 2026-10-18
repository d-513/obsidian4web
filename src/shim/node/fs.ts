// Node.js "fs" module implemented on top of the in-memory VFS.

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { normalize, vfs, type VNode } from "../vfs/vfs";
import { fsError } from "../vfs/errors";

type PathLike = string | Buffer | URL | Uint8Array;
type Encoding = BufferEncoding | null | undefined;
type Callback<T = void> = (err: Error | null, result?: T) => void;

export function toPath(p: PathLike): string {
  if (typeof p === "string") return p.startsWith("file://") ? fileUrlToPath(p) : p;
  if (p instanceof URL) return fileUrlToPath(p.href);
  if (p instanceof Uint8Array) return Buffer.from(p).toString("utf8");
  return String(p);
}

function fileUrlToPath(href: string): string {
  const u = new URL(href);
  return decodeURIComponent(u.pathname);
}

function getEncoding(opts: unknown): Encoding {
  if (typeof opts === "string") return opts as BufferEncoding;
  if (opts && typeof opts === "object" && "encoding" in opts) return (opts as { encoding: Encoding }).encoding;
  return null;
}

function getFlag(opts: unknown, def: string): string {
  if (opts && typeof opts === "object" && "flag" in opts && (opts as { flag?: string }).flag) {
    return (opts as { flag: string }).flag;
  }
  return def;
}

export function toBytes(data: unknown, encoding?: Encoding): Uint8Array {
  if (typeof data === "string") return Buffer.from(data, encoding || "utf8");
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return Buffer.from(String(data), "utf8");
}

function decode(data: Uint8Array, encoding: Encoding): string | Buffer {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (encoding && (encoding as string) !== "buffer") return buf.toString(encoding);
  // Return a copy so callers can't mutate our cache.
  return Buffer.from(buf);
}

// ---------------------------------------------------------------------------
// Stats & Dirent

export class Stats {
  dev = 2114;
  ino: number;
  mode: number;
  nlink = 1;
  uid = 501;
  gid = 20;
  rdev = 0;
  size: number;
  blksize = 4096;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  private readonly _type: "file" | "dir";

  constructor(node: VNode) {
    this._type = node.type;
    this.ino = node.ino;
    this.mode = node.mode;
    this.size = node.type === "dir" ? 64 : node.size;
    this.blocks = Math.ceil(this.size / 512);
    this.atimeMs = node.atime;
    this.mtimeMs = node.mtime;
    this.ctimeMs = node.ctime;
    this.birthtimeMs = node.birthtime;
    this.atime = new Date(node.atime);
    this.mtime = new Date(node.mtime);
    this.ctime = new Date(node.ctime);
    this.birthtime = new Date(node.birthtime);
  }
  isFile() {
    return this._type === "file";
  }
  isDirectory() {
    return this._type === "dir";
  }
  isSymbolicLink() {
    return false;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

export class Dirent {
  constructor(
    public name: string,
    private readonly _type: "file" | "dir",
    public parentPath: string,
  ) {}
  get path() {
    return this.parentPath;
  }
  isFile() {
    return this._type === "file";
  }
  isDirectory() {
    return this._type === "dir";
  }
  isSymbolicLink() {
    return false;
  }
  isBlockDevice() {
    return false;
  }
  isCharacterDevice() {
    return false;
  }
  isFIFO() {
    return false;
  }
  isSocket() {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sync API

function statSync(p: PathLike, opts?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const path = toPath(p);
  if (opts && opts.throwIfNoEntry === false && !vfs.exists(path)) return undefined;
  return new Stats(vfs.stat(path));
}

function readdirSync(p: PathLike, opts?: unknown): (string | Buffer | Dirent)[] {
  const path = normalize(toPath(p));
  const withTypes = !!(opts && typeof opts === "object" && (opts as { withFileTypes?: boolean }).withFileTypes);
  const recursive = !!(opts && typeof opts === "object" && (opts as { recursive?: boolean }).recursive);
  const enc = getEncoding(opts);
  const out: (string | Buffer | Dirent)[] = [];
  const visit = (dir: string, rel: string) => {
    for (const node of vfs.readdirNodes(dir)) {
      const name = rel ? rel + "/" + node.name : node.name;
      if (withTypes) out.push(new Dirent(node.name, node.type, dir));
      else out.push((enc as string) === "buffer" ? Buffer.from(name) : name);
      if (recursive && node.type === "dir") visit(dir === "/" ? "/" + node.name : dir + "/" + node.name, name);
    }
  };
  visit(path, "");
  return out;
}

function readFileSync(p: PathLike | number, opts?: unknown): string | Buffer {
  if (typeof p === "number") return decode(fdReadAll(p), getEncoding(opts));
  return decode(vfs.readSync(toPath(p)), getEncoding(opts));
}

function writeFileSync(p: PathLike | number, data: unknown, opts?: unknown): void {
  if (typeof p === "number") {
    fdWrite(p, toBytes(data, getEncoding(opts)), null);
    return;
  }
  const flag = getFlag(opts, "w");
  void vfs.write(toPath(p), toBytes(data, getEncoding(opts)), { flag: flag.startsWith("a") ? "a" : flag === "wx" ? "wx" : "w" });
}

function appendFileSync(p: PathLike, data: unknown, opts?: unknown): void {
  void vfs.write(toPath(p), toBytes(data, getEncoding(opts)), { flag: "a" });
}

function mkdirSync(p: PathLike, opts?: unknown): string | undefined {
  const recursive = !!(opts && typeof opts === "object" && (opts as { recursive?: boolean }).recursive);
  const path = toPath(p);
  if (recursive && vfs.exists(path)) {
    if (vfs.stat(path).type !== "dir") throw fsError("EEXIST", "mkdir", path);
    return undefined;
  }
  return vfs.mkdir(path, recursive);
}

function rmdirSync(p: PathLike, opts?: { recursive?: boolean }): void {
  void vfs.rmdir(toPath(p), !!opts?.recursive);
}

function rmSync(p: PathLike, opts?: { recursive?: boolean; force?: boolean }): void {
  void vfs.rm(toPath(p), opts);
}

function unlinkSync(p: PathLike): void {
  void vfs.unlink(toPath(p));
}

function renameSync(a: PathLike, b: PathLike): void {
  void vfs.rename(toPath(a), toPath(b));
}

function copyFileSync(a: PathLike, b: PathLike, mode = 0): void {
  vfs.copyFileSync(toPath(a), toPath(b), (mode & 1) === 1);
}

function cpSync(a: PathLike, b: PathLike): void {
  const src = toPath(a);
  const dst = toPath(b);
  const node = vfs.stat(src);
  if (node.type === "file") return copyFileSync(src, dst);
  mkdirSync(dst, { recursive: true });
  for (const name of vfs.readdir(src)) cpSync(src + "/" + name, dst + "/" + name);
}

function existsSync(p: PathLike): boolean {
  try {
    return vfs.exists(toPath(p));
  } catch {
    return false;
  }
}

function accessSync(p: PathLike): void {
  vfs.stat(toPath(p), "access");
}

function realpathSync(p: PathLike): string {
  const path = toPath(p);
  vfs.stat(path, "realpath");
  return normalize(path);
}
realpathSync.native = realpathSync;

function utimesSync(p: PathLike, atime: number | Date | string, mtime: number | Date | string): void {
  void vfs.utimes(toPath(p), toMs(atime), toMs(mtime));
}

function toMs(t: number | Date | string): number {
  if (t instanceof Date) return t.getTime();
  if (typeof t === "string") return Number(t) * 1000;
  // Node accepts seconds (number) for utimes.
  return t < 1e11 ? t * 1000 : t;
}

function truncateSync(p: PathLike, len = 0): void {
  void vfs.truncate(toPath(p), len);
}

function mkdtempSync(prefix: string): string {
  const path = prefix + Math.random().toString(36).slice(2, 8);
  vfs.mkdir(path, true);
  return path;
}

// ---------------------------------------------------------------------------
// File descriptors (minimal, buffered)

interface Fd {
  path: string;
  flags: string;
  pos: number;
  data: Uint8Array;
  dirty: boolean;
}
const fds = new Map<number, Fd>();
let nextFd = 100;

function openSync(p: PathLike, flags: string | number = "r"): number {
  const path = normalize(toPath(p));
  const f = typeof flags === "number" ? (flags & 1 ? "w" : "r") : flags;
  let data: Uint8Array;
  if (f.startsWith("r")) {
    data = vfs.readSync(path);
  } else if (f.startsWith("a")) {
    data = vfs.exists(path) ? vfs.readSync(path) : new Uint8Array(0);
  } else {
    if (f.includes("x") && vfs.exists(path)) throw fsError("EEXIST", "open", path);
    data = new Uint8Array(0);
    void vfs.write(path, data);
  }
  const fd = nextFd++;
  fds.set(fd, { path, flags: f, pos: f.startsWith("a") ? data.byteLength : 0, data, dirty: false });
  return fd;
}

async function openAsync(p: PathLike, flags: string | number = "r"): Promise<number> {
  const path = normalize(toPath(p));
  const f = typeof flags === "number" ? (flags & 1 ? "w" : "r") : flags;
  if ((f.startsWith("r") || f.startsWith("a")) && vfs.exists(path)) await vfs.read(path);
  return openSync(path, f);
}

function getFd(fd: number): Fd {
  const h = fds.get(fd);
  if (!h) throw fsError("EBADF", "read");
  return h;
}

function fdReadAll(fd: number): Uint8Array {
  const h = getFd(fd);
  return h.data.subarray(h.pos);
}

function readSync(fd: number, buffer: Uint8Array, offset = 0, length?: number, position?: number | null): number {
  const h = getFd(fd);
  if (typeof offset === "object" && offset !== null) {
    const o = offset as { offset?: number; length?: number; position?: number };
    return readSync(fd, buffer, o.offset ?? 0, o.length, o.position);
  }
  length ??= buffer.byteLength - offset;
  const pos = position ?? h.pos;
  const chunk = h.data.subarray(pos, pos + length);
  buffer.set(chunk, offset);
  if (position === null || position === undefined) h.pos += chunk.byteLength;
  return chunk.byteLength;
}

function fdWrite(fd: number, bytes: Uint8Array, position: number | null | undefined): number {
  const h = getFd(fd);
  const pos = position ?? h.pos;
  const end = pos + bytes.byteLength;
  if (end > h.data.byteLength) {
    const grown = new Uint8Array(end);
    grown.set(h.data);
    h.data = grown;
  } else {
    h.data = h.data.slice();
  }
  h.data.set(bytes, pos);
  if (position === null || position === undefined) h.pos = end;
  h.dirty = true;
  return bytes.byteLength;
}

function writeSync(fd: number, data: unknown, offsetOrPos?: number | null, lengthOrEnc?: number | string, position?: number | null): number {
  if (typeof data === "string") return fdWrite(fd, toBytes(data, (lengthOrEnc as BufferEncoding) || "utf8"), offsetOrPos);
  const bytes = toBytes(data);
  const offset = offsetOrPos ?? 0;
  const length = typeof lengthOrEnc === "number" ? lengthOrEnc : bytes.byteLength - offset;
  return fdWrite(fd, bytes.subarray(offset, offset + length), position);
}

function closeSync(fd: number): void {
  const h = fds.get(fd);
  if (!h) return;
  fds.delete(fd);
  if (h.dirty) void vfs.write(h.path, h.data);
}

function fstatSync(fd: number): Stats {
  const h = getFd(fd);
  const s = new Stats(vfs.stat(h.path));
  s.size = h.data.byteLength;
  return s;
}

function ftruncateSync(fd: number, len = 0): void {
  const h = getFd(fd);
  const out = new Uint8Array(len);
  out.set(h.data.subarray(0, len));
  h.data = out;
  h.dirty = true;
}

class FileHandle {
  constructor(readonly fd: number) {}
  async read(buffer: Uint8Array | { buffer?: Uint8Array; offset?: number; length?: number; position?: number }, offset?: number, length?: number, position?: number | null) {
    let buf: Uint8Array;
    if (buffer instanceof Uint8Array) buf = buffer;
    else {
      buf = buffer?.buffer ?? Buffer.alloc(16384);
      offset = buffer?.offset;
      length = buffer?.length;
      position = buffer?.position;
    }
    const bytesRead = readSync(this.fd, buf, offset ?? 0, length, position);
    return { bytesRead, buffer: buf };
  }
  async write(data: unknown, a?: number | null, b?: number | string, c?: number | null) {
    const bytesWritten = writeSync(this.fd, data, a, b, c);
    return { bytesWritten, buffer: data };
  }
  async readFile(opts?: unknown) {
    return decode(getFd(this.fd).data, getEncoding(opts));
  }
  async writeFile(data: unknown, opts?: unknown) {
    const h = getFd(this.fd);
    h.data = toBytes(data, getEncoding(opts)).slice();
    h.pos = h.data.byteLength;
    h.dirty = true;
  }
  async appendFile(data: unknown, opts?: unknown) {
    const h = getFd(this.fd);
    fdWrite(this.fd, toBytes(data, getEncoding(opts)), h.data.byteLength);
  }
  async stat() {
    return fstatSync(this.fd);
  }
  async truncate(len = 0) {
    ftruncateSync(this.fd, len);
  }
  async sync() {
    const h = getFd(this.fd);
    if (h.dirty) {
      h.dirty = false;
      await vfs.write(h.path, h.data);
    }
  }
  async datasync() {
    return this.sync();
  }
  async close() {
    const h = fds.get(this.fd);
    if (!h) return;
    fds.delete(this.fd);
    if (h.dirty) await vfs.write(h.path, h.data);
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

// ---------------------------------------------------------------------------
// Watching

export class FSWatcher extends EventEmitter {
  private stop: (() => void) | null;
  constructor(path: string, recursive: boolean, listener?: (event: string, filename: string) => void) {
    super();
    if (listener) this.on("change", listener);
    this.stop = vfs.watch(path, recursive, (event, filename) => this.emit("change", event, filename));
  }
  close() {
    this.stop?.();
    this.stop = null;
    this.emit("close");
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

function watch(p: PathLike, opts?: unknown, listener?: (event: string, filename: string) => void): FSWatcher {
  if (typeof opts === "function") {
    listener = opts as typeof listener;
    opts = undefined;
  }
  const path = normalize(toPath(p));
  if (!vfs.exists(path)) throw fsError("ENOENT", "watch", path);
  const recursive = !!(opts && typeof opts === "object" && (opts as { recursive?: boolean }).recursive);
  return new FSWatcher(path, recursive, listener);
}

const fileWatchers = new Map<string, Map<Function, () => void>>();

function emptyStats(): Stats {
  const s = new Stats({ type: "file", name: "", parent: null, ino: 0, mode: 0, size: 0, mtime: 0, ctime: 0, birthtime: 0, atime: 0 });
  return s;
}

function watchFile(p: PathLike, opts?: unknown, listener?: (curr: Stats, prev: Stats) => void): void {
  if (typeof opts === "function") listener = opts as typeof listener;
  const path = normalize(toPath(p));
  let prev = vfs.exists(path) ? new Stats(vfs.stat(path)) : emptyStats();
  const stop = vfs.watch(path, false, () => {
    const curr = vfs.exists(path) ? new Stats(vfs.stat(path)) : emptyStats();
    listener?.(curr, prev);
    prev = curr;
  });
  if (!fileWatchers.has(path)) fileWatchers.set(path, new Map());
  fileWatchers.get(path)!.set(listener as Function, stop);
}

function unwatchFile(p: PathLike, listener?: Function): void {
  const path = normalize(toPath(p));
  const map = fileWatchers.get(path);
  if (!map) return;
  for (const [l, stop] of map) {
    if (!listener || l === listener) {
      stop();
      map.delete(l);
    }
  }
}

// ---------------------------------------------------------------------------
// Promise API

const tick = () => new Promise<void>((r) => queueMicrotask(r));

const promises = {
  async readFile(p: PathLike | FileHandle, opts?: unknown) {
    if (p instanceof FileHandle) return p.readFile(opts);
    return decode(await vfs.read(toPath(p)), getEncoding(opts));
  },
  async writeFile(p: PathLike | FileHandle, data: unknown, opts?: unknown) {
    if (p instanceof FileHandle) return p.writeFile(data, opts);
    const path = toPath(p);
    const flag = getFlag(opts, "w");
    if (flag.startsWith("a") && vfs.exists(path)) await vfs.read(path);
    if (data && typeof data === "object" && Symbol.asyncIterator in (data as object)) {
      const chunks: Uint8Array[] = [];
      for await (const c of data as AsyncIterable<unknown>) chunks.push(toBytes(c));
      data = Buffer.concat(chunks);
    }
    await vfs.write(path, toBytes(data, getEncoding(opts)), { flag: flag.startsWith("a") ? "a" : flag === "wx" ? "wx" : "w" });
  },
  async appendFile(p: PathLike | FileHandle, data: unknown, opts?: unknown) {
    if (p instanceof FileHandle) return p.appendFile(data, opts);
    const path = toPath(p);
    if (vfs.exists(path)) await vfs.read(path);
    await vfs.write(path, toBytes(data, getEncoding(opts)), { flag: "a" });
  },
  async stat(p: PathLike) {
    await tick();
    return new Stats(vfs.stat(toPath(p)));
  },
  async lstat(p: PathLike) {
    await tick();
    return new Stats(vfs.stat(toPath(p), "lstat"));
  },
  async readdir(p: PathLike, opts?: unknown) {
    await tick();
    return readdirSync(p, opts);
  },
  async mkdir(p: PathLike, opts?: unknown) {
    await tick();
    return mkdirSync(p, opts);
  },
  async rmdir(p: PathLike, opts?: { recursive?: boolean }) {
    await vfs.rmdir(toPath(p), !!opts?.recursive);
  },
  async rm(p: PathLike, opts?: { recursive?: boolean; force?: boolean }) {
    await vfs.rm(toPath(p), opts);
  },
  async unlink(p: PathLike) {
    await vfs.unlink(toPath(p));
  },
  async rename(a: PathLike, b: PathLike) {
    await vfs.rename(toPath(a), toPath(b));
  },
  async copyFile(a: PathLike, b: PathLike, mode = 0) {
    await vfs.copyFile(toPath(a), toPath(b), (mode & 1) === 1);
  },
  async cp(a: PathLike, b: PathLike) {
    await vfs.copyRecursive(toPath(a), toPath(b));
  },
  async access(p: PathLike) {
    await tick();
    accessSync(p);
  },
  async realpath(p: PathLike) {
    await tick();
    return realpathSync(p);
  },
  async utimes(p: PathLike, atime: number | Date, mtime: number | Date) {
    await vfs.utimes(toPath(p), toMs(atime), toMs(mtime));
  },
  async lutimes(p: PathLike, atime: number | Date, mtime: number | Date) {
    await vfs.utimes(toPath(p), toMs(atime), toMs(mtime));
  },
  async truncate(p: PathLike, len = 0) {
    const path = toPath(p);
    await vfs.read(path);
    await vfs.truncate(path, len);
  },
  async open(p: PathLike, flags?: string | number) {
    return new FileHandle(await openAsync(p, flags));
  },
  async mkdtemp(prefix: string) {
    return mkdtempSync(prefix);
  },
  async chmod() {},
  async chown() {},
  async lchown() {},
  async link(a: PathLike, b: PathLike) {
    await vfs.copyFile(toPath(a), toPath(b));
  },
  async symlink() {
    throw fsError("ENOSYS", "symlink");
  },
  async readlink(p: PathLike) {
    throw fsError("EINVAL", "readlink", toPath(p));
  },
  async *watch(p: PathLike, opts?: { recursive?: boolean; signal?: AbortSignal }) {
    const path = normalize(toPath(p));
    const queue: { eventType: string; filename: string }[] = [];
    let wake: (() => void) | null = null;
    const stop = vfs.watch(path, !!opts?.recursive, (eventType, filename) => {
      queue.push({ eventType, filename });
      wake?.();
    });
    try {
      while (!opts?.signal?.aborted) {
        if (!queue.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (queue.length) yield queue.shift()!;
      }
    } finally {
      stop();
    }
  },
  constants: undefined as unknown,
};

// ---------------------------------------------------------------------------
// Callback API (derived from the promise API)

function callbackify<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as Callback<R>) : null;
    fn(...(args as A)).then(
      (r) => cb && setTimeout(() => cb(null, r), 0),
      (e) => cb && setTimeout(() => cb(e), 0),
    );
  };
}

function exists(p: PathLike, cb: (exists: boolean) => void) {
  const r = existsSync(p);
  setTimeout(() => cb(r), 0);
}

function readCb(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, cb: Callback<number>) {
  try {
    const n = readSync(fd, buffer, offset, length, position);
    setTimeout(() => (cb as (e: null, n: number, b: Uint8Array) => void)(null, n, buffer), 0);
  } catch (e) {
    setTimeout(() => cb(e as Error), 0);
  }
}

function writeCb(fd: number, data: unknown, ...rest: unknown[]) {
  const cb = rest.pop() as Callback<number>;
  try {
    const n = writeSync(fd, data, ...(rest as [number, number, number]));
    setTimeout(() => (cb as (e: null, n: number, d: unknown) => void)(null, n, data), 0);
  } catch (e) {
    setTimeout(() => cb(e as Error), 0);
  }
}

function syncCb<A extends unknown[], R>(fn: (...a: A) => R) {
  return (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as Callback<R>) : null;
    try {
      const r = fn(...(args as A));
      if (cb) setTimeout(() => cb(null, r), 0);
    } catch (e) {
      if (cb) setTimeout(() => cb(e as Error), 0);
    }
  };
}

// ---------------------------------------------------------------------------
// Streams (minimal)

class ReadStream extends EventEmitter {
  readable = true;
  bytesRead = 0;
  constructor(readonly path: string, opts?: { start?: number; end?: number; encoding?: BufferEncoding }) {
    super();
    void (async () => {
      try {
        let data = await vfs.read(path);
        const start = opts?.start ?? 0;
        const end = opts?.end !== undefined ? opts.end + 1 : data.byteLength;
        data = data.subarray(start, end);
        this.emit("open", 0);
        this.emit("ready");
        const chunk = Buffer.from(data);
        this.bytesRead = chunk.byteLength;
        this.emit("data", opts?.encoding ? chunk.toString(opts.encoding) : chunk);
        this.readable = false;
        this.emit("end");
        this.emit("close");
      } catch (e) {
        this.emit("error", e);
      }
    })();
  }
  pipe<T extends { write(c: unknown): unknown; end(): unknown }>(dest: T): T {
    this.on("data", (c) => dest.write(c));
    this.on("end", () => dest.end());
    return dest;
  }
  destroy() {
    this.removeAllListeners();
    return this;
  }
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(await vfs.read(this.path));
  }
}

class WriteStream extends EventEmitter {
  writable = true;
  bytesWritten = 0;
  private chunks: Uint8Array[] = [];
  constructor(readonly path: string, private readonly opts?: { flags?: string }) {
    super();
    setTimeout(() => {
      this.emit("open", 0);
      this.emit("ready");
    }, 0);
  }
  write(chunk: unknown, enc?: unknown, cb?: () => void) {
    if (typeof enc === "function") cb = enc as () => void;
    const b = toBytes(chunk, typeof enc === "string" ? (enc as BufferEncoding) : undefined);
    this.chunks.push(b);
    this.bytesWritten += b.byteLength;
    cb && setTimeout(cb, 0);
    return true;
  }
  end(chunk?: unknown, enc?: unknown, cb?: () => void) {
    if (typeof chunk === "function") {
      cb = chunk as () => void;
      chunk = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, enc);
    const flag = this.opts?.flags?.startsWith("a") ? "a" : "w";
    vfs.write(this.path, Buffer.concat(this.chunks), { flag }).then(
      () => {
        this.writable = false;
        this.emit("finish");
        this.emit("close");
        cb?.();
      },
      (e) => this.emit("error", e),
    );
    return this;
  }
  close(cb?: () => void) {
    this.end(cb);
  }
  destroy() {
    this.removeAllListeners();
    return this;
  }
}

// ---------------------------------------------------------------------------

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  O_CREAT: 512,
  O_EXCL: 2048,
  O_TRUNC: 1024,
  O_APPEND: 8,
  S_IFMT: 0o170000,
  S_IFREG: 0o100000,
  S_IFDIR: 0o040000,
  S_IFLNK: 0o120000,
  UV_FS_COPYFILE_EXCL: 1,
};
promises.constants = constants;

export const fs = {
  constants,
  Stats,
  Dirent,
  FSWatcher,
  ReadStream,
  WriteStream,
  promises,
  // sync
  existsSync,
  statSync,
  lstatSync: statSync,
  fstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  renameSync,
  copyFileSync,
  cpSync,
  accessSync,
  realpathSync,
  utimesSync,
  lutimesSync: utimesSync,
  futimesSync() {},
  truncateSync,
  ftruncateSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fsyncSync() {},
  fdatasyncSync() {},
  chmodSync() {},
  chownSync() {},
  lchownSync() {},
  symlinkSync() {
    throw fsError("ENOSYS", "symlink");
  },
  readlinkSync(p: PathLike) {
    throw fsError("EINVAL", "readlink", toPath(p));
  },
  linkSync: copyFileSync,
  // callbacks
  exists,
  stat: callbackify(promises.stat),
  lstat: callbackify(promises.lstat),
  fstat: syncCb(fstatSync),
  readdir: callbackify(promises.readdir),
  readFile: callbackify(promises.readFile as (p: PathLike, o?: unknown) => Promise<string | Buffer>),
  writeFile: callbackify(promises.writeFile as (p: PathLike, d: unknown, o?: unknown) => Promise<void>),
  appendFile: callbackify(promises.appendFile as (p: PathLike, d: unknown, o?: unknown) => Promise<void>),
  mkdir: callbackify(promises.mkdir),
  mkdtemp: callbackify(promises.mkdtemp),
  rmdir: callbackify(promises.rmdir),
  rm: callbackify(promises.rm),
  unlink: callbackify(promises.unlink),
  rename: callbackify(promises.rename),
  copyFile: callbackify(promises.copyFile),
  cp: callbackify(promises.cp),
  access: callbackify(promises.access),
  realpath: Object.assign(callbackify(promises.realpath), { native: callbackify(promises.realpath) }),
  utimes: callbackify(promises.utimes),
  lutimes: callbackify(promises.utimes),
  truncate: callbackify(promises.truncate),
  open: callbackify(openAsync),
  close: syncCb(closeSync),
  read: readCb,
  write: writeCb,
  ftruncate: syncCb(ftruncateSync),
  fsync: syncCb(() => {}),
  fdatasync: syncCb(() => {}),
  chmod: syncCb(() => {}),
  chown: syncCb(() => {}),
  futimes: syncCb(() => {}),
  symlink: callbackify(promises.symlink),
  readlink: callbackify(promises.readlink),
  watch,
  watchFile,
  unwatchFile,
  createReadStream(p: PathLike, opts?: { start?: number; end?: number; encoding?: BufferEncoding }) {
    return new ReadStream(normalize(toPath(p)), opts);
  },
  createWriteStream(p: PathLike, opts?: { flags?: string }) {
    return new WriteStream(normalize(toPath(p)), opts);
  },
};

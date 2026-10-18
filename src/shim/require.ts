// window.require: the Node/Electron modules available to Obsidian and its plugins.
import { Buffer } from "buffer";
import { fs } from "./node/fs";
import { path } from "./node/path";
import { url } from "./node/url";
import { os } from "./node/os";
import { nodeCrypto } from "./node/crypto";
import { util, eventsModule, bufferModule, childProcess, netModule, timersModule, stringDecoder } from "./node/misc";
import { process } from "./globals";
import { createElectron } from "./electron/renderer";
import { vfs } from "./vfs/vfs";

function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "Assertion failed");
}
Object.assign(assert, {
  ok: assert,
  equal: (a: unknown, b: unknown, m?: string) => assert(a == b, m),
  strictEqual: (a: unknown, b: unknown, m?: string) => assert(a === b, m),
  notEqual: (a: unknown, b: unknown, m?: string) => assert(a != b, m),
  deepEqual: (a: unknown, b: unknown, m?: string) => assert(JSON.stringify(a) === JSON.stringify(b), m),
  deepStrictEqual: (a: unknown, b: unknown, m?: string) => assert(JSON.stringify(a) === JSON.stringify(b), m),
  fail: (m?: string) => assert(false, m),
});

const querystring = {
  parse: (s: string) => Object.fromEntries(new URLSearchParams(s)),
  stringify: (o: Record<string, string>) => new URLSearchParams(o).toString(),
  escape: encodeURIComponent,
  unescape: decodeURIComponent,
};

const btime = {
  btime(p: string, time: number | Date) {
    void vfs.setBirthtime(p, time instanceof Date ? time.getTime() : time);
  },
};

async function listFonts(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (!q) return [];
  try {
    return [...new Set((await q()).map((f) => f.family))].sort();
  } catch {
    return [];
  }
}

const getFonts = {
  getFonts: listFonts,
  default: listFonts,
};

const shared: Record<string, unknown> = {
  fs,
  "original-fs": fs,
  "fs/promises": fs.promises,
  path,
  "path/posix": path,
  url,
  os,
  crypto: nodeCrypto,
  util,
  events: eventsModule,
  buffer: bufferModule,
  child_process: childProcess,
  net: netModule,
  tls: netModule,
  http: netModule,
  https: netModule,
  http2: netModule,
  dns: netModule,
  dgram: netModule,
  cluster: netModule,
  worker_threads: { isMainThread: true, Worker: undefined, parentPort: null },
  timers: timersModule,
  "timers/promises": timersModule.promises,
  string_decoder: stringDecoder,
  assert,
  querystring,
  process,
  btime,
  "get-fonts": getFonts,
  constants: fs.constants,
  module: { builtinModules: [] },
  v8: {},
  vm: { runInThisContext: (code: string) => (0, eval)(code) },
  zlib: netModule,
};

export function makeRequire(win: Window) {
  let electron: ReturnType<typeof createElectron> | null = null;
  const req = function require(name: string): unknown {
    const id = name.startsWith("node:") ? name.slice(5) : name;
    if (id === "electron") return (electron ??= createElectron(win));
    if (id === "@electron/remote") return (electron ??= createElectron(win)).remote;
    if (id in shared) return shared[id];
    const err = new Error(`Cannot find module '${name}'`) as Error & { code: string };
    err.code = "MODULE_NOT_FOUND";
    throw err;
  } as ((name: string) => unknown) & { resolve(n: string): string; cache: object };
  req.resolve = (n: string) => n;
  req.cache = {};
  return req;
}

export { Buffer };

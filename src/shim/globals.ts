// Node-style globals expected by Obsidian's renderer (nodeIntegration: true).
import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { platform, PATHS } from "./platform";

class Process extends EventEmitter {
  platform = platform.process;
  arch = platform.arch;
  version = "v" + platform.node;
  versions = {
    node: platform.node,
    electron: platform.electron,
    chrome: platform.chrome,
    v8: "13.0",
    uv: "1.48.0",
    modules: "130",
  };
  env: Record<string, string> = {
    HOME: PATHS.home,
    USER: "user",
    LANG: (navigator.language || "en-US").replace("-", "_") + ".UTF-8",
    PATH: "/usr/bin:/bin",
    TMPDIR: "/tmp",
  };
  argv = ["/opt/obsidian/obsidian", "/opt/obsidian/resources/app.asar"];
  execPath = "/opt/obsidian/obsidian";
  execArgv: string[] = [];
  pid = 4242;
  ppid = 4241;
  title = "obsidian";
  type = "renderer";
  resourcesPath = "/opt/obsidian/resources";
  contextIsolated = false;
  sandboxed = false;
  isMainFrame = true;
  browser = true;
  exitCode = 0;
  stdout = { write: (s: string) => (console.log(String(s).replace(/\n$/, "")), true), isTTY: false };
  stderr = { write: (s: string) => (console.error(String(s).replace(/\n$/, "")), true), isTTY: false };
  cwd() {
    return "/";
  }
  chdir() {}
  umask() {
    return 0o22;
  }
  getuid() {
    return 501;
  }
  getgid() {
    return 20;
  }
  uptime() {
    return performance.now() / 1000;
  }
  hrtime = Object.assign(
    (prev?: [number, number]) => {
      const t = performance.now();
      const s = Math.floor(t / 1000);
      const ns = Math.floor((t % 1000) * 1e6);
      if (!prev) return [s, ns];
      let ds = s - prev[0];
      let dn = ns - prev[1];
      if (dn < 0) {
        ds--;
        dn += 1e9;
      }
      return [ds, dn];
    },
    { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
  );
  memoryUsage() {
    const m = (performance as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return { rss: m?.totalJSHeapSize ?? 0, heapTotal: m?.totalJSHeapSize ?? 0, heapUsed: m?.usedJSHeapSize ?? 0, external: 0, arrayBuffers: 0 };
  }
  getProcessMemoryInfo() {
    return Promise.resolve({ private: 0, shared: 0, residentSet: 0 });
  }
  cpuUsage() {
    return { user: 0, system: 0 };
  }
  nextTick(fn: (...a: unknown[]) => void, ...args: unknown[]) {
    queueMicrotask(() => fn(...args));
  }
  emitWarning(w: unknown) {
    console.warn(w);
  }
  exit() {
    console.warn("process.exit() called; ignoring");
  }
  abort() {}
  kill() {
    return false;
  }
  binding() {
    throw new Error("process.binding is not supported");
  }
}

export const process = new Process();

export function installGlobals(win: Window & typeof globalThis): void {
  const w = win as unknown as Record<string, unknown>;
  w.process = process;
  w.Buffer = Buffer;
  w.global = win;
  if (!w.setImmediate) {
    w.setImmediate = (fn: (...a: unknown[]) => void, ...args: unknown[]) => win.setTimeout(fn, 0, ...args);
    w.clearImmediate = (id: number) => win.clearTimeout(id);
  }
  w.__dirname = "/opt/obsidian/resources/app.asar";
  w.__filename = "/opt/obsidian/resources/app.asar/index.html";
}

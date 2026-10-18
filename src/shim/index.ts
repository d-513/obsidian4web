// Shim entry point. Injected (by the service worker) as the first script of Obsidian's
// HTML pages. Sets up the Node/Electron environment synchronously, mounts storage
// asynchronously, then loads Obsidian's own scripts in their original order.

import { basePath } from "../common/config";
import { installGlobals } from "./globals";
import { makeRequire } from "./require";
import { patchNetwork } from "./net/net";
import { trackActivation } from "./ui/dialogs";
import { vfs } from "./vfs/vfs";
import { IdbBackend } from "./vfs/idb";
import { FsaBackend } from "./vfs/fsa";
import { MemoryBackend } from "./vfs/backend";
import { DownloadsBackend } from "./vfs/downloads";
import { PATHS } from "./platform";
import { addFolder, folderIdOf, folderMountPath, getFolder, loadConfig, takeVaultActions } from "./state";
import { page, isNavigating, applyFavicon, checkForUpdate, deliverAction, handleObsidianUrl } from "./electron/main";
import { showModal } from "./ui/ui";
import { detectProxy, ensureSession } from "../common/proxy-client";
import { setupPopout } from "./popout";
import { defineWebview } from "./webview";

type AnyWin = Window & typeof globalThis;

// ---------------------------------------------------------------------------
// Synchronous environment

function setupWindow(win: AnyWin): void {
  (win as unknown as { __O4W_BASE__?: string }).__O4W_BASE__ = basePath();
  installGlobals(win);
  patchNetwork(win);
  (win as unknown as { require: unknown }).require = makeRequire(win);
  trackActivation(win);
  try {
    defineWebview(win);
  } catch (e) {
    console.error("[o4w] webview support unavailable", e);
  }
}

setupWindow(window);

// Debug/automation handle.
(window as unknown as { __o4w: unknown }).__o4w = { vfs, addFolder, folderMountPath, FsaBackend, loadConfig };

// Keep a small log of errors/warnings for diagnostics (window.__o4wLog).
const diag: string[] = [];
(window as unknown as { __o4wLog: string[] }).__o4wLog = diag;
for (const level of ["error", "warn"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    diag.push(level + ": " + args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : safeJson(a))).join(" "));
    if (diag.length > 300) diag.shift();
    orig(...args);
  };
}
window.addEventListener("error", (e) => diag.push("uncaught: " + (e.error?.stack || e.message)));
window.addEventListener("unhandledrejection", (e) => diag.push("unhandled rejection: " + ((e.reason as Error)?.stack || String(e.reason))));
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 500) ?? String(v);
  } catch {
    return String(v);
  }
}

// Popout windows: Obsidian opens about:blank popups and builds them from this window.
const nativeOpen = window.open.bind(window);
const STANDARD_FEATURES = new Set(["popup", "width", "height", "left", "top", "x", "y", "screenx", "screeny", "innerwidth", "innerheight", "noopener", "noreferrer"]);
window.open = function (url?: string | URL, target?: string, features?: string) {
  // Electron-only features (background=, parented=) make Chrome return null.
  if (features) {
    features = features
      .split(",")
      .filter((f) => STANDARD_FEATURES.has(f.split("=")[0].trim().toLowerCase()))
      .map((f) => f.replace(/^\s*x=/i, "left=").replace(/^\s*y=/i, "top="))
      .join(",");
  }
  const w = nativeOpen(url, target, features);
  const href = url === undefined ? "" : String(url);
  if (w && (href === "" || href === "about:blank")) {
    try {
      setupWindow(w as AnyWin);
      if (!(w as AnyWin).navigator.serviceWorker?.controller) setupPopout(w);
    } catch (e) {
      console.error("[o4w] failed to prepare popout window", e);
    }
  }
  return w;
} as typeof window.open;

// Starter/vault switching calls window.close() right after asking to open another vault.
const nativeClose = window.close.bind(window);
window.close = () => {
  if (isNavigating()) return;
  nativeClose();
};

// obsidian:// links clicked inside the app.
document.addEventListener(
  "click",
  (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href^='obsidian:']") as HTMLAnchorElement | null;
    if (a && !e.defaultPrevented) {
      e.preventDefault();
      handleObsidianUrl(a.href);
    }
  },
  false,
);

// Late DOMContentLoaded/load listeners (our scripts run after parsing) still fire.
const nativeAdd = Document.prototype.addEventListener;
document.addEventListener = function (this: Document, type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
  if (type === "DOMContentLoaded" && this.readyState !== "loading" && scriptsStarted) {
    setTimeout(() => (typeof listener === "function" ? listener.call(this, new Event(type)) : listener.handleEvent(new Event(type))), 0);
    return;
  }
  return nativeAdd.call(this, type, listener, opts);
} as typeof document.addEventListener;
const nativeWinAdd = window.addEventListener.bind(window);
window.addEventListener = function (type: string, listener: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
  if (type === "load" && document.readyState === "complete" && scriptsStarted) {
    setTimeout(() => (typeof listener === "function" ? listener.call(window, new Event(type)) : listener.handleEvent(new Event(type))), 0);
    return;
  }
  return nativeWinAdd(type, listener, opts);
} as typeof window.addEventListener;

let scriptsStarted = false;

// Hook the Obsidian App instance as soon as it is created (window.app = new App()).
let appInstance: unknown;
Object.defineProperty(window, "app", {
  configurable: true,
  get: () => appInstance,
  set(v: { vault?: { getConfig?: (k: string) => unknown } }) {
    appInstance = v;
    const vault = v?.vault;
    if (vault?.getConfig) {
      const orig = vault.getConfig.bind(vault);
      // Native (Electron) menus default to on for macOS; in a browser Obsidian's own
      // menus are better, so default to those unless the user picked something.
      vault.getConfig = (k: string) => {
        const r = orig(k);
        return k === "nativeMenus" && (r === null || r === undefined) ? false : r;
      };
    }
  },
});

// Warn before closing while data is still being written.
nativeWinAdd("beforeunload", (e: BeforeUnloadEvent) => {
  if (vfs.pendingWrites() > 0 && !isNavigating()) {
    e.preventDefault();
    e.returnValue = "Changes are still being saved.";
  }
});

// ---------------------------------------------------------------------------
// Serve vault files to the service worker (resource URLs like /_vfs/vaults/x/img.png)

let resolveReady!: () => void;
const vfsReady = new Promise<void>((r) => (resolveReady = r));

navigator.serviceWorker?.addEventListener("message", async (e: MessageEvent) => {
  const msg = e.data as { type?: string; path?: string; range?: [number, number] | null };
  if (msg?.type !== "o4w-vfs-read" || !e.ports[0]) return;
  const port = e.ports[0];
  await vfsReady;
  const path = msg.path!;
  try {
    if (!vfs.exists(path)) {
      port.postMessage({ ok: false, status: 404, mounted: false });
      return;
    }
    const node = vfs.stat(path);
    if (node.type !== "file") {
      port.postMessage({ ok: false, status: 404 });
      return;
    }
    if (msg.range) {
      const { data, size } = await vfs.readRange(path, msg.range[0], msg.range[1]);
      const buf = data.slice().buffer;
      port.postMessage({ ok: true, status: 206, data: buf, size, mtime: node.mtime }, [buf]);
    } else {
      const data = await vfs.read(path);
      const buf = data.slice().buffer;
      port.postMessage({ ok: true, status: 200, data: buf, size: data.byteLength, mtime: node.mtime }, [buf]);
    }
  } catch (err) {
    console.error("[o4w] vfs read for service worker failed", path, err);
    port.postMessage({ ok: false, status: 500 });
  }
});

// ---------------------------------------------------------------------------
// Async boot

function overlay(message: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "o4w-boot";
  el.innerHTML = `<div class="o4w-boot-inner"><div class="o4w-spinner"></div><div class="o4w-boot-msg"></div></div>`;
  el.querySelector(".o4w-boot-msg")!.textContent = message;
  (document.body ?? document.documentElement).appendChild(el);
  return el;
}

async function mountBase(): Promise<void> {
  await vfs.mount("/", new IdbBackend(""));
  await vfs.mount(PATHS.temp, new MemoryBackend());
  await vfs.mount(PATHS.mnt, new MemoryBackend());
  await vfs.mount(PATHS.downloads, new DownloadsBackend());
  for (const d of [PATHS.home, PATHS.userData, PATHS.documents, PATHS.desktop, PATHS.vaults]) {
    if (!vfs.exists(d)) vfs.mkdir(d, true);
  }
}

/** Mount the local folder backing a vault; may need a click to re-grant permission. */
async function mountFolderFor(vaultPath: string): Promise<boolean> {
  const id = folderIdOf(vaultPath);
  if (!id) return true;
  const rec = await getFolder(id);
  if (!rec) return false;
  if (!(await FsaBackend.ensurePermission(rec.handle, false))) {
    const ok = await new Promise<boolean>((resolve) => {
      void showModal({
        title: `Allow access to “${rec.name}”`,
        message: `This vault is stored in a folder on your computer. Your browser needs your permission again to read and write “${rec.name}”.`,
        buttons: [
          { text: "Allow access", cta: true, value: 0 },
          { text: "Open another vault", value: 1 },
        ],
        cancelValue: 1,
      }).then(async ({ response }) => {
        if (response !== 0) return resolve(false);
        resolve(await FsaBackend.ensurePermission(rec.handle, true));
      });
    });
    if (!ok) return false;
  }
  const status = overlay(`Reading “${rec.name}”…`);
  try {
    await vfs.mount(folderMountPath(rec), new FsaBackend(rec.handle));
  } finally {
    status.remove();
  }
  return true;
}

function loadDeferredScripts(): void {
  scriptsStarted = true;
  const placeholders = [...document.querySelectorAll('script[type="o4w/deferred"]')] as HTMLScriptElement[];
  for (const ph of placeholders) {
    const s = document.createElement("script");
    for (const attr of [...ph.attributes]) {
      if (attr.name === "type" || attr.name === "data-src" || attr.name === "defer") continue;
      s.setAttribute(attr.name, attr.value);
    }
    s.src = ph.dataset.src!;
    s.async = false;
    ph.replaceWith(s);
  }
}

async function boot(): Promise<void> {
  const base = basePath();
  if (!navigator.serviceWorker?.controller) {
    // Opened without the service worker (e.g. hard reload); let the launcher fix it.
    location.replace(base + "?next=" + encodeURIComponent(location.pathname + location.search));
    return;
  }
  const caps = detectProxy().then((c) => (c.proxy ? ensureSession() : false));
  await mountBase();
  await caps;
  const cfg = loadConfig();

  if (!cfg.termsAccepted) {
    location.replace(base);
    return;
  }

  if (page.kind === "vault") {
    const vault = page.vaultId ? cfg.vaults[page.vaultId] : undefined;
    if (!vault) {
      location.replace(base + "starter.html");
      return;
    }
    if (!(await mountFolderFor(vault.path))) {
      location.replace(base + "starter.html");
      return;
    }
    // Config files are read synchronously by some code paths (and many plugins).
    await vfs.preload(vault.path + "/.obsidian");
    localStorage.setItem("o4w-last-vault", page.vaultId!);
    const actions = takeVaultActions(page.vaultId!);
    if (actions.length) {
      deliverAction(window, actions[0]);
      if (actions.length > 1) {
        const rest = actions.slice(1);
        const timer = setInterval(() => {
          if (typeof (window as unknown as { OBS_ACT?: unknown }).OBS_ACT === "function") {
            clearInterval(timer);
            for (const a of rest) deliverAction(window, a);
          }
        }, 500);
      }
    }
    setTimeout(() => void checkForUpdate(), 15000);
  } else {
    // Starter: make folders of local-disk vaults "exist" so they show up as available.
    for (const v of Object.values(cfg.vaults)) {
      if (folderIdOf(v.path) && !vfs.exists(v.path)) vfs.mkdir(v.path, true);
    }
  }
  resolveReady();
  applyFavicon(document);
  loadDeferredScripts();
}

boot().catch((e) => {
  console.error("[o4w] boot failed", e);
  const el = overlay("Failed to start: " + ((e as Error)?.message ?? e));
  el.querySelector(".o4w-spinner")?.remove();
});

// Emulation of Obsidian's Electron main process (the ipcMain handlers in main.js).

import { Buffer } from "buffer";
import { basePath } from "../../common/config";
import { canAutoDownload, compareVersions, fetchReleaseInfo, installRelease } from "../../common/installer";
import { vfs, normalize } from "../vfs/vfs";
import { PATHS } from "../platform";
import { loadConfig, queueVaultAction, randomId, updateConfig } from "../state";
import { proxyRequest } from "../net/net";
import { dialog, messageBox } from "../ui/dialogs";
import { notice, popupMenu, type MenuTemplateItem } from "../ui/ui";

export const TERMS =
  "I understand and agree that I am not allowed to distribute the Obsidian application, in any form, without explicit approval from the Obsidian team. I also understand that Obsidian is a registered trademark, and I cannot use it without explicit permission granted by the Obsidian team.";

export interface IpcEvent {
  returnValue: unknown;
  sender: { id: number; send(channel: string, ...args: unknown[]): void };
  reply(channel: string, ...args: unknown[]): void;
  win: Window;
}

type Handler = (event: IpcEvent, ...args: any[]) => unknown;

export const appVersion: string = (window as unknown as { __O4W_VERSION__?: string }).__O4W_VERSION__ ?? "1.0.0";
const BASE = basePath();

// ---------------------------------------------------------------------------
// Window context

export const page = (() => {
  const rel = location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : location.pathname;
  const p = rel.replace(/^\/+/, "");
  const params = new URLSearchParams(location.search);
  return {
    kind: p === "starter.html" ? "starter" : p === "help.html" ? "help" : "vault",
    vaultId: params.get("vault"),
  } as { kind: "starter" | "help" | "vault"; vaultId: string | null };
})();

let navigating = false;

export function isNavigating(): boolean {
  return navigating;
}

function vaultUrl(id: string): string {
  return `${BASE}index.html?vault=${encodeURIComponent(id)}`;
}

/** Navigate this tab once pending writes (e.g. a freshly created vault folder) are stored. */
function navigateTo(url: string): void {
  navigating = true;
  void vfs.flush().then(() => location.assign(url));
}

/** Open a vault: in this tab when we're the starter, else in a new tab. */
export function openVault(id: string, opts: { sameTab?: boolean } = {}): void {
  const url = vaultUrl(id);
  if (opts.sameTab ?? page.kind !== "vault") navigateTo(url);
  else if (!window.open(url, "_blank")) navigateTo(url);
}

export function openStarter(sameTab: boolean): void {
  if (sameTab || !window.open(`${BASE}starter.html`, "_blank")) navigateTo(`${BASE}starter.html`);
}

function setVaultOpen(id: string): void {
  updateConfig((c) => {
    const v = c.vaults[id];
    if (v) v.ts = Date.now();
  });
}

/** Mirrors main.js h(): register (if needed) and open a vault folder. */
function openVaultPath(path: string, sameTab?: boolean): true | string {
  if (!path || typeof path !== "string") return "folder not found";
  path = normalize(path);
  if (!vfs.exists(path)) return "folder not found";
  const cfg = loadConfig();
  for (const id in cfg.vaults) {
    if (cfg.vaults[id].path === path) {
      setVaultOpen(id);
      openVault(id, { sameTab });
      return true;
    }
  }
  const id = randomId(16);
  updateConfig((c) => {
    c.vaults[id] = { path, ts: Date.now() };
  });
  openVault(id, { sameTab });
  return true;
}

// ---------------------------------------------------------------------------
// Updates (Obsidian's in-app updater -> our installer)

const update = { state: "", checking: false, latest: "" };

export async function checkForUpdate(force = false): Promise<void> {
  const cfg = loadConfig();
  if ((cfg.updateDisabled && !force) || update.checking) return;
  update.checking = true;
  try {
    const info = await fetchReleaseInfo();
    update.latest = info.latestVersion;
    if (compareVersions(info.latestVersion, appVersion) > 0) {
      if (await canAutoDownload(info)) {
        await installRelease(info);
        update.state = "update-downloaded";
      } else if (force || localStorage.getItem("o4w-update-noticed") !== info.latestVersion) {
        // Without a proxy the release can't be downloaded from here; send the user to the launcher.
        localStorage.setItem("o4w-update-noticed", info.latestVersion);
        notice(`Obsidian ${info.latestVersion} is available. Open ${location.origin}${BASE}?manage to install it.`, 15000);
      }
    }
  } catch (e) {
    console.warn("[o4w] update check failed", e);
  } finally {
    update.checking = false;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function copyAsarDir(prefix: string, target: string): Promise<void> {
  return (async () => {
    const res = await fetch(`${BASE}__o4w/asar-list?prefix=` + encodeURIComponent(prefix));
    const files = (await res.json()) as string[];
    vfs.mkdir(target, true);
    for (const f of files) {
      const rel = f.slice(prefix.length).replace(/^\/+/, "");
      const dest = target + "/" + rel;
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      if (!vfs.exists(dir)) vfs.mkdir(dir, true);
      const data = new Uint8Array(await (await fetch(BASE + f.split("/").map(encodeURIComponent).join("/"))).arrayBuffer());
      await vfs.write(dest, data);
    }
  })();
}

/** System trash: move into a per-browser trash folder. */
function trash(path: string): boolean {
  try {
    path = normalize(path);
    if (!vfs.exists(path)) return false;
    const dir = PATHS.home + "/.Trash";
    if (!vfs.exists(dir)) vfs.mkdir(dir, true);
    const name = path.slice(path.lastIndexOf("/") + 1);
    let dest = dir + "/" + name;
    if (vfs.exists(dest)) dest = `${dir}/${name} ${new Date().toISOString().replace(/[:.]/g, "-")}`;
    void vfs.rename(path, dest);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function openExternal(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

async function openUrl(event: IpcEvent, url: string): Promise<void> {
  const scheme = /^([a-z][a-z0-9+\-.]*):/i.exec(url)?.[1]?.toLowerCase() ?? "";
  if (!scheme || scheme === "about" || scheme === "app") return;
  if (scheme === "obsidian") {
    handleObsidianUrl(url);
    return;
  }
  if (scheme === "file") {
    const path = decodeURIComponent(url.replace(/^file:(\/\/)?/, "").split("#")[0]);
    if (vfs.exists(path)) event.win.open(BASE + "_vfs/" + path.replace(/^\/+/, ""), "_blank");
    return;
  }
  const cfg = loadConfig();
  if (scheme !== "http" && scheme !== "https" && scheme !== "mailto" && !cfg.openSchemes?.[scheme]) {
    const r = await messageBox({
      title: "Open external link",
      message: "This link will open in another application.\n\nLink: " + url.slice(0, 200),
      buttons: ["Open link", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      checkboxLabel: `Always open "${scheme}" links`,
    });
    if (r.response !== 0) return;
    if (r.checkboxChecked) updateConfig((c) => ((c.openSchemes ??= {})[scheme] = true));
  }
  openExternal(url);
}

/** obsidian:// URLs: deliver to this window when it is the right vault, else open the vault. */
export function handleObsidianUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  const action = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0]) || "open";
  const params: Record<string, string> = { action };
  u.searchParams.forEach((v, k) => (params[k] = v));
  const cfg = loadConfig();
  let target: string | null = null;
  if (params.vault) {
    for (const id in cfg.vaults) {
      const name = cfg.vaults[id].path.split("/").pop();
      if (id === params.vault || name === params.vault) target = id;
    }
  } else if (params.path) {
    for (const id in cfg.vaults) if (params.path.startsWith(cfg.vaults[id].path + "/")) target = id;
  }
  target ??= page.vaultId;
  if (!target) return;
  if (target === page.vaultId) {
    deliverAction(window, params);
  } else {
    queueVaultAction(target, params);
    openVault(target, { sameTab: false });
  }
}

export function deliverAction(win: Window, act: unknown): void {
  const w = win as unknown as { OBS_ACT?: unknown };
  if (typeof w.OBS_ACT === "function") (w.OBS_ACT as (a: unknown) => void)(act);
  else w.OBS_ACT = act;
}

let appMenuTemplate: MenuTemplateItem[] | null = null;

// ---------------------------------------------------------------------------
// Handlers

export const handlers: Record<string, Handler> = {
  terms: (e) => {
    e.returnValue = loadConfig().termsAccepted ? TERMS : "";
  },
  "is-quitting": (e) => (e.returnValue = false),
  "is-closing": (e) => (e.returnValue = isNavigating()),
  "desktop-dir": (e) => (e.returnValue = PATHS.desktop),
  "documents-dir": (e) => (e.returnValue = PATHS.documents),
  resources: (e) => (e.returnValue = BASE.replace(/\/$/, "") || "/"),
  version: (e) => (e.returnValue = appVersion),
  policy: (e) =>
    (e.returnValue = { plugins: true, themes: true, snippets: true, sync: true, publish: true, webViewer: true, devTools: true, insider: false }),
  "set-language": (e, lang?: string) => {
    updateConfig((c) => {
      if (lang) c.language = lang;
      else delete c.language;
    });
    e.returnValue = null;
  },
  "file-url": (e) => (e.returnValue = location.origin + BASE + "_vfs/"),
  relaunch: (e) => {
    e.returnValue = "";
    navigating = true;
    void vfs.flush().then(() => location.reload());
  },
  update: (e) => (e.returnValue = update.state),
  "latest-public-version": (e) => (e.returnValue = update.latest),
  "check-update": (e, force?: boolean) => {
    if (force) void checkForUpdate(true);
    e.returnValue = update.checking;
  },
  "disable-update": (e, v?: boolean) => {
    if (v === true || v === false) updateConfig((c) => (v ? (c.updateDisabled = true) : delete c.updateDisabled));
    e.returnValue = !!loadConfig().updateDisabled;
  },
  "copy-asar": (e) => (e.returnValue = false),
  "disable-gpu": (e, v?: boolean) => {
    if (v === true || v === false) updateConfig((c) => (v ? (c.disableGpu = true) : delete c.disableGpu));
    e.returnValue = !!loadConfig().disableGpu;
  },
  "insider-build": (e) => (e.returnValue = false),
  cli: (e) => (e.returnValue = false),
  frame: (e, v?: string) => {
    if (typeof v === "string") updateConfig((c) => (v ? (c.frame = v) : delete c.frame));
    // In a browser tab the browser provides the window chrome.
    e.returnValue = loadConfig().frame ?? "native";
  },
  "adblock-lists": (e, v?: string[]) => {
    if (Array.isArray(v)) updateConfig((c) => (c.adblock = v));
    e.returnValue = loadConfig().adblock ?? [];
  },
  "adblock-frequency": (e, v?: number) => {
    if (typeof v === "number") updateConfig((c) => (c.adblockFrequency = v));
    e.returnValue = loadConfig().adblockFrequency ?? 4;
  },
  "print-to-pdf": async (e, opts: { filepath?: string; open?: boolean }) => {
    // Browsers can't print silently to a file; open the print dialog (Save as PDF).
    try {
      await new Promise((r) => setTimeout(r, 50));
      e.win.print();
    } finally {
      e.sender.send("print-to-pdf", {});
    }
    void opts;
  },
  vault: (e) => {
    const id = page.vaultId;
    const v = id ? loadConfig().vaults[id] : undefined;
    e.returnValue = v && id ? { id, path: normalize(v.path) } : {};
  },
  "vault-list": (e) => (e.returnValue = loadConfig().vaults),
  "vault-remove": (e, path: string) => {
    let ok = false;
    if (path && typeof path === "string") {
      updateConfig((c) => {
        for (const id in c.vaults) {
          if (c.vaults[id].path === path) {
            delete c.vaults[id];
            ok = true;
          }
        }
      });
    }
    e.returnValue = ok;
  },
  "vault-move": (e, from: string, to: string) => {
    const cfg = loadConfig();
    for (const id in cfg.vaults) {
      if (cfg.vaults[id].path !== from) continue;
      try {
        if (vfs.mountOf(normalize(from)) !== vfs.mountOf(normalize(to))) {
          e.returnValue = "Moving vaults between browser storage and disk folders is not supported.";
          return;
        }
        void vfs.rename(from, to);
      } catch (err) {
        e.returnValue = String(err);
        return;
      }
      updateConfig((c) => (c.vaults[id].path = normalize(to)));
      e.returnValue = "";
      return;
    }
    e.returnValue = false;
  },
  "vault-open": (e, path: string, create?: boolean) => {
    if (create) {
      if (vfs.exists(path)) {
        e.returnValue = "Vault already exists";
        return;
      }
      try {
        vfs.mkdir(path, true);
      } catch (err) {
        e.returnValue = String(err);
        return;
      }
    }
    e.returnValue = openVaultPath(path);
  },
  "vault-message": (e, path: string, msg: unknown) => {
    path = normalize(path);
    const cfg = loadConfig();
    for (const id in cfg.vaults) {
      if (cfg.vaults[id].path === path) {
        if (id === page.vaultId) deliverAction(window, msg);
        else queueVaultAction(id, msg);
        break;
      }
    }
    e.returnValue = "";
  },
  starter: (e) => {
    e.returnValue = null;
    // During boot (vault missing) replace this tab; otherwise open the manager in a new tab.
    const booting = !(window as unknown as { app?: unknown }).app;
    openStarter(booting || page.kind !== "vault");
  },
  help: (e) => {
    e.returnValue = null;
    window.open(`${BASE}help.html`, "_blank");
  },
  sandbox: (e) => {
    e.returnValue = null;
    void (async () => {
      const target = PATHS.sandbox;
      if (vfs.exists(target)) await vfs.rm(target, { recursive: true, force: true });
      await copyAsarDir("sandbox", target);
      openVaultPath(target, page.kind !== "vault");
    })();
  },
  "context-menu": (e) => {
    // No native spellcheck suggestions are available; answer right away.
    setTimeout(() => e.sender.send("context-menu", null), 0);
  },
  "request-url": async (e, replyId: string, req: { url: string; method?: string; contentType?: string; body?: string | ArrayBuffer; headers?: Record<string, string> }) => {
    try {
      const res = await proxyRequest(req);
      e.reply(replyId, { status: res.status, headers: res.headers, body: res.body });
    } catch (err) {
      e.reply(replyId, { error: err });
    }
  },
  "open-url": (e, url: string) => {
    if (typeof url === "string") void openUrl(e, url);
  },
  "open-file": async (e, extensions: string[]) => {
    const r = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Supported files", extensions }],
    });
    const p = r.filePaths[0];
    if (r.canceled || !p) return;
    deliverAction(e.win, { action: "open", path: p });
  },
  trash: (e, path: string) => (e.returnValue = trash(path)),
  "get-documents-path": (e) => (e.returnValue = PATHS.documents),
  "get-sandbox-vault-path": (e) => (e.returnValue = PATHS.sandbox),
  "get-default-vault-path": (e) => (e.returnValue = PATHS.vaults + "/Obsidian Vault"),
  "set-menu": (_e, { template }: { template: MenuTemplateItem[] }) => {
    appMenuTemplate = template;
  },
  "update-menu-items": () => {},
  "render-menu": (e) => {
    if (appMenuTemplate) popupMenu(appMenuTemplate, 8, 32, e.win.document, () => {});
  },
  "set-icon": (e, name?: string, data?: Uint8Array) => {
    updateConfig((c) => {
      if (name && data) {
        c.icon = name;
        const b64 = Buffer.from(data).toString("base64");
        localStorage.setItem("o4w-icon", `data:image/${name.endsWith(".ico") ? "x-icon" : "png"};base64,${b64}`);
      } else {
        delete c.icon;
        localStorage.removeItem("o4w-icon");
      }
    });
    applyFavicon(document);
    e.returnValue = null;
  },
  "get-icon": (e) => (e.returnValue = loadConfig().icon),
  "create-browser-session": () => {},
  "register-cli": () => ({ success: false, message: "The command line interface is not available in the browser." }),
};

export function applyFavicon(doc: Document): void {
  const icon = localStorage.getItem("o4w-icon") || `${BASE}icon.png`;
  let link = doc.querySelector('link[rel="icon"]') as HTMLLinkElement | null;
  if (!link) {
    link = doc.createElement("link");
    link.rel = "icon";
    doc.head.appendChild(link);
  }
  link.href = icon;
}

// Renderer-side Electron API: ipcRenderer, remote, webFrame, clipboard, shell, nativeImage…

import { Buffer } from "buffer";
import { EventEmitter } from "events";
import { handlers, appVersion, isNavigating, type IpcEvent } from "./main";
import { dialog } from "../ui/dialogs";
import { popupMenu, performRole, type MenuTemplateItem } from "../ui/ui";
import { process } from "../globals";
import { PATHS } from "../platform";
import { vfs, normalize } from "../vfs/vfs";
import { basePath } from "../../common/config";

// ---------------------------------------------------------------------------
// ipcRenderer (one per tab; popout windows share it)

class IpcRenderer extends EventEmitter {
  private makeEvent(win: Window): IpcEvent {
    const self = this;
    return {
      returnValue: undefined,
      win,
      sender: {
        id: 1,
        send(channel: string, ...args: unknown[]) {
          setTimeout(() => self.emit(channel, { sender: self }, ...args), 0);
        },
      },
      reply(channel: string, ...args: unknown[]) {
        setTimeout(() => self.emit(channel, { sender: self }, ...args), 0);
      },
    };
  }

  sendSync(channel: string, ...args: unknown[]): unknown {
    const h = handlers[channel];
    if (!h) {
      console.warn("[o4w] unhandled ipc sendSync:", channel, args);
      return undefined;
    }
    const e = this.makeEvent(currentWin);
    const r = h(e, ...args);
    if (r instanceof Promise) r.catch((err) => console.error("[o4w] ipc", channel, err));
    return e.returnValue;
  }

  send(channel: string, ...args: unknown[]): void {
    const h = handlers[channel];
    if (!h) {
      console.warn("[o4w] unhandled ipc send:", channel, args);
      return;
    }
    const e = this.makeEvent(currentWin);
    Promise.resolve()
      .then(() => h(e, ...args))
      .catch((err) => console.error("[o4w] ipc", channel, err));
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const h = handlers[channel];
    if (!h) throw new Error(`No handler registered for '${channel}'`);
    const e = this.makeEvent(currentWin);
    const r = await h(e, ...args);
    return r !== undefined ? r : e.returnValue;
  }

  sendTo() {}
  sendToHost() {}
  postMessage() {}
}

export const ipcRenderer = new IpcRenderer();
ipcRenderer.setMaxListeners(0);

/** The window whose code is currently calling into the shim (best effort). */
let currentWin: Window = window;

// ---------------------------------------------------------------------------
// nativeImage

class NativeImage {
  constructor(private readonly bytes: Uint8Array, private readonly mime = "image/png", private size = { width: 0, height: 0 }) {}
  toPNG() {
    return Buffer.from(this.bytes);
  }
  toJPEG() {
    return Buffer.from(this.bytes);
  }
  toBitmap() {
    return Buffer.from(this.bytes);
  }
  getBitmap() {
    return Buffer.from(this.bytes);
  }
  toDataURL() {
    return `data:${this.mime};base64,` + Buffer.from(this.bytes).toString("base64");
  }
  getSize() {
    return this.size;
  }
  isEmpty() {
    return this.bytes.byteLength === 0;
  }
  resize() {
    return this;
  }
  crop() {
    return this;
  }
  getAspectRatio() {
    return this.size.height ? this.size.width / this.size.height : 1;
  }
  setTemplateImage() {}
  isTemplateImage() {
    return false;
  }
  toBlob() {
    return new Blob([this.bytes as BlobPart], { type: this.mime });
  }
}

const nativeImage = {
  createEmpty: () => new NativeImage(new Uint8Array(0)),
  createFromBuffer: (b: Uint8Array) => new NativeImage(new Uint8Array(b)),
  createFromDataURL: (url: string) => {
    const [head, data] = url.split(",");
    const mime = /data:([^;]+)/.exec(head)?.[1] ?? "image/png";
    return new NativeImage(Buffer.from(data, "base64"), mime);
  },
  createFromPath: (p: string) => {
    try {
      return new NativeImage(vfs.readSync(p));
    } catch {
      return new NativeImage(new Uint8Array(0));
    }
  },
  createFromBitmap: (b: Uint8Array) => new NativeImage(new Uint8Array(b)),
};

// ---------------------------------------------------------------------------
// Clipboard (Electron's is synchronous; ours returns promises where needed,
// which Obsidian awaits through its navigator.clipboard wrapper).

let clipboardCache = "";
document.addEventListener("copy", () => {
  setTimeout(() => navigator.clipboard?.readText?.().then((t) => (clipboardCache = t), () => {}), 0);
});

const clipboard = {
  readText(): string {
    const p = navigator.clipboard?.readText?.();
    if (p) {
      const thenable = p.then((t) => (clipboardCache = t));
      // Return a string-like promise: works for both sync callers (best effort) and awaiters.
      return Object.assign(thenable, { toString: () => clipboardCache }) as unknown as string;
    }
    return clipboardCache;
  },
  writeText(text: string) {
    clipboardCache = text;
    return navigator.clipboard?.writeText(text).catch(() => fallbackCopy(text));
  },
  readHTML(): string {
    return "";
  },
  writeHTML(html: string) {
    return clipboard.write({ html });
  },
  readRTF: () => "",
  writeRTF() {},
  readImage: () => nativeImage.createEmpty(),
  writeImage(img: NativeImage) {
    try {
      const blob = img.toBlob();
      return navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch (e) {
      console.error(e);
    }
  },
  write(data: { text?: string; html?: string; image?: NativeImage }) {
    const items: Record<string, Blob> = {};
    if (data.text !== undefined) {
      items["text/plain"] = new Blob([data.text], { type: "text/plain" });
      clipboardCache = data.text;
    }
    if (data.html !== undefined) items["text/html"] = new Blob([data.html], { type: "text/html" });
    if (data.image) items["image/png"] = data.image.toBlob();
    try {
      return navigator.clipboard.write([new ClipboardItem(items)]).catch(() => data.text && fallbackCopy(data.text));
    } catch {
      if (data.text) fallbackCopy(data.text);
    }
  },
  availableFormats: () => ["text/plain"],
  has: () => false,
  read: () => "",
  readBookmark: () => ({ title: "", url: "" }),
  writeBookmark() {},
  readFindText: () => "",
  writeFindText() {},
  clear() {
    void navigator.clipboard?.writeText("");
  },
};

function fallbackCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

// ---------------------------------------------------------------------------
// shell

const shell = {
  openExternal(url: string) {
    if (/^obsidian:/i.test(url)) ipcRenderer.send("open-url", url);
    else window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  },
  async openPath(path: string) {
    path = normalize(path);
    if (!vfs.exists(path)) return "File not found";
    window.open(basePath() + "_vfs/" + path.slice(1).split("/").map(encodeURIComponent).join("/"), "_blank");
    return "";
  },
  showItemInFolder(path: string) {
    void shell.openPath(path);
  },
  async trashItem(path: string) {
    if (!ipcRenderer.sendSync("trash", path)) throw new Error("Failed to move to trash");
  },
  beep() {},
  readShortcutLink: () => ({}),
  writeShortcutLink: () => false,
};

// ---------------------------------------------------------------------------
// Zoom (Electron's webFrame zoom → CSS zoom on the document root)

function applyZoom(win: Window, level: number) {
  const st = win.document.documentElement.style as CSSStyleDeclaration & { zoom: string };
  st.zoom = level ? String(Math.pow(1.2, level)) : "";
  (win as unknown as { __o4wZoom: number }).__o4wZoom = level;
  win.dispatchEvent(new Event("resize"));
}

function zoomOf(win: Window): number {
  return (win as unknown as { __o4wZoom?: number }).__o4wZoom ?? 0;
}

// ---------------------------------------------------------------------------
// Session (spellcheck etc.)

const spellLangs = new Set<string>([navigator.language]);

const session = {
  availableSpellCheckerLanguages: [...new Set([navigator.language, ...(navigator.languages ?? []), "en-US"])],
  getSpellCheckerLanguages: () => [...spellLangs],
  setSpellCheckerLanguages: (langs: string[]) => {
    spellLangs.clear();
    for (const l of langs) spellLangs.add(l);
  },
  setSpellCheckerEnabled() {},
  isSpellCheckerEnabled: () => true,
  addWordToSpellCheckerDictionary: () => true,
  removeWordFromSpellCheckerDictionary: () => true,
  listWordsInSpellCheckerDictionary: async () => [],
  clearCache: async () => {},
  clearStorageData: async () => {},
  getUserAgent: () => navigator.userAgent,
  setUserAgent() {},
  setProxy: async () => {},
  setPermissionRequestHandler() {},
  setPermissionCheckHandler() {},
  setDevicePermissionHandler() {},
  cookies: { get: async () => [], set: async () => {}, remove: async () => {}, on() {}, flushStore: async () => {} },
  webRequest: { onBeforeRequest() {}, onBeforeSendHeaders() {}, onHeadersReceived() {}, onCompleted() {}, onErrorOccurred() {} },
  protocol: { handle() {}, unhandle() {}, isProtocolHandled: () => false },
  on() {},
  once() {},
  removeListener() {},
};

// ---------------------------------------------------------------------------
// WebContents & BrowserWindow (per window)

let nextId = 1;
const webContentsById = new Map<number, WebContents>();
const windowsByWin = new WeakMap<Window, BrowserWindow>();

/** Register a webContents-like object (e.g. for a <webview>) and return its id. */
export function registerWebContents(wc: object): number {
  const id = nextId++;
  webContentsById.set(id, wc as WebContents);
  return id;
}

class WebContents extends EventEmitter {
  readonly id = nextId++;
  readonly session = session;
  constructor(readonly win: Window) {
    super();
    webContentsById.set(this.id, this);
  }
  getURL() {
    return this.win.location.href;
  }
  getTitle() {
    return this.win.document.title;
  }
  isFocused() {
    return this.win.document.hasFocus();
  }
  focus() {
    this.win.focus();
  }
  isDestroyed() {
    return this.win.closed;
  }
  isLoading() {
    return this.win.document.readyState !== "complete";
  }
  getZoomLevel() {
    return zoomOf(this.win);
  }
  setZoomLevel(level: number) {
    applyZoom(this.win, level);
  }
  getZoomFactor() {
    return Math.pow(1.2, zoomOf(this.win));
  }
  setZoomFactor(f: number) {
    applyZoom(this.win, Math.log(f) / Math.log(1.2));
  }
  setVisualZoomLevelLimits() {
    return Promise.resolve();
  }
  undo() {
    this.win.document.execCommand("undo");
  }
  redo() {
    this.win.document.execCommand("redo");
  }
  cut() {
    this.win.document.execCommand("cut");
  }
  copy() {
    this.win.document.execCommand("copy");
  }
  paste() {
    performRole("paste", this.win.document);
  }
  pasteAndMatchStyle() {
    this.paste();
  }
  delete() {
    this.win.document.execCommand("delete");
  }
  selectAll() {
    this.win.document.execCommand("selectAll");
  }
  unselect() {
    this.win.getSelection()?.removeAllRanges();
  }
  replace(text: string) {
    this.win.document.execCommand("insertText", false, text);
  }
  replaceMisspelling(text: string) {
    this.win.document.execCommand("insertText", false, text);
  }
  insertText(text: string) {
    this.win.document.execCommand("insertText", false, text);
    return Promise.resolve();
  }
  findInPage(text: string, opts?: { forward?: boolean; matchCase?: boolean }) {
    const found = (this.win as unknown as { find?: (...a: unknown[]) => boolean }).find?.(text, !!opts?.matchCase, opts?.forward === false, true);
    setTimeout(() => this.emit("found-in-page", {}, { requestId: 1, activeMatchOrdinal: found ? 1 : 0, matches: found ? 1 : 0, finalUpdate: true }), 0);
    return 1;
  }
  stopFindInPage() {
    this.win.getSelection()?.collapseToEnd?.();
  }
  showDefinitionForSelection() {}
  openDevTools() {
    console.info("[o4w] Open your browser's developer tools (F12 / Cmd+Opt+I).");
  }
  closeDevTools() {}
  toggleDevTools() {
    this.openDevTools();
  }
  isDevToolsOpened() {
    return false;
  }
  inspectElement() {}
  reload() {
    this.win.location.reload();
  }
  reloadIgnoringCache() {
    this.win.location.reload();
  }
  print() {
    this.win.print();
  }
  async printToPDF() {
    this.win.print();
    return Buffer.alloc(0);
  }
  async capturePage(rect?: { x: number; y: number; width: number; height: number }) {
    void rect;
    return nativeImage.createEmpty();
  }
  async executeJavaScript(code: string) {
    return (this.win as unknown as { eval(c: string): unknown }).eval(code);
  }
  send(channel: string, ...args: unknown[]) {
    setTimeout(() => ipcRenderer.emit(channel, { sender: ipcRenderer }, ...args), 0);
  }
  setWindowOpenHandler() {}
  setAudioMuted() {}
  isAudioMuted() {
    return false;
  }
  setBackgroundThrottling() {}
  setIgnoreMenuShortcuts() {}
  getOSProcessId() {
    return process.pid;
  }
  getProcessId() {
    return process.pid;
  }
  get focusedFrame() {
    return null;
  }
  get mainFrame() {
    return { url: this.getURL(), frames: [] };
  }
  get hostWebContents() {
    return null;
  }
  get devToolsWebContents() {
    return null;
  }
}

class BrowserWindow extends EventEmitter {
  readonly id: number;
  readonly webContents: WebContents;
  private minSize: [number, number] = [0, 0];
  private alwaysOnTop = false;
  constructor(readonly win: Window) {
    super();
    this.webContents = new WebContents(win);
    this.id = this.webContents.id;
    windowsByWin.set(win, this);
    win.addEventListener("focus", () => this.emit("focus"));
    win.addEventListener("blur", () => this.emit("blur"));
    win.addEventListener("resize", () => this.emit("resize"));
    win.document.addEventListener("fullscreenchange", () =>
      this.emit(win.document.fullscreenElement ? "enter-full-screen" : "leave-full-screen"),
    );
    win.addEventListener("beforeunload", () => this.emit("close", { preventDefault() {}, defaultPrevented: false }));
    win.addEventListener("unload", () => {
      this.emit("closed");
      webContentsById.delete(this.id);
    });
  }
  isFocused() {
    return this.win.document.hasFocus();
  }
  focus() {
    this.win.focus();
  }
  blur() {}
  show() {
    this.win.focus();
  }
  showInactive() {}
  hide() {}
  isVisible() {
    return this.win.document.visibilityState === "visible";
  }
  isDestroyed() {
    return this.win.closed;
  }
  close() {
    this.win.close();
  }
  destroy() {
    this.win.close();
  }
  minimize() {}
  restore() {}
  isMinimized() {
    return this.win.document.visibilityState === "hidden";
  }
  maximize() {
    this.emit("maximize");
  }
  unmaximize() {
    this.emit("unmaximize");
  }
  isMaximized() {
    return this.win.outerWidth >= screen.availWidth - 8 && this.win.outerHeight >= screen.availHeight - 8;
  }
  isMaximizable() {
    return true;
  }
  isMinimizable() {
    return true;
  }
  isResizable() {
    return true;
  }
  isFullScreen() {
    return !!this.win.document.fullscreenElement;
  }
  setFullScreen(flag: boolean) {
    if (flag) void this.win.document.documentElement.requestFullscreen?.().catch(() => {});
    else if (this.win.document.fullscreenElement) void this.win.document.exitFullscreen();
  }
  isSimpleFullScreen() {
    return this.isFullScreen();
  }
  setSimpleFullScreen(f: boolean) {
    this.setFullScreen(f);
  }
  setTitle(t: string) {
    this.win.document.title = t;
  }
  getTitle() {
    return this.win.document.title;
  }
  getBounds() {
    return { x: this.win.screenX, y: this.win.screenY, width: this.win.outerWidth, height: this.win.outerHeight };
  }
  getContentBounds() {
    return { x: this.win.screenX, y: this.win.screenY, width: this.win.innerWidth, height: this.win.innerHeight };
  }
  getNormalBounds() {
    return this.getBounds();
  }
  setBounds(b: { x?: number; y?: number; width?: number; height?: number }) {
    try {
      if (b.width && b.height) this.win.resizeTo(b.width, b.height);
      if (b.x !== undefined && b.y !== undefined) this.win.moveTo(b.x, b.y);
    } catch {
      /* not allowed for tabs */
    }
  }
  getSize() {
    return [this.win.outerWidth, this.win.outerHeight];
  }
  setSize(w: number, h: number) {
    this.setBounds({ width: w, height: h });
  }
  getContentSize() {
    return [this.win.innerWidth, this.win.innerHeight];
  }
  setContentSize(w: number, h: number) {
    this.setBounds({ width: w, height: h });
  }
  getPosition() {
    return [this.win.screenX, this.win.screenY];
  }
  setPosition(x: number, y: number) {
    this.setBounds({ x, y });
  }
  center() {}
  setMinimumSize(w: number, h: number) {
    this.minSize = [w, h];
  }
  getMinimumSize() {
    return this.minSize;
  }
  setMaximumSize() {}
  setAlwaysOnTop(f: boolean) {
    this.alwaysOnTop = f;
  }
  isAlwaysOnTop() {
    return this.alwaysOnTop;
  }
  setBackgroundColor() {}
  getBackgroundColor() {
    return "#00000000";
  }
  setVibrancy() {}
  setBackgroundMaterial() {}
  setOpacity() {}
  setIcon() {}
  setMenu() {}
  removeMenu() {}
  setMenuBarVisibility() {}
  setAutoHideMenuBar() {}
  isMenuBarVisible() {
    return false;
  }
  setWindowButtonVisibility() {}
  setTrafficLightPosition() {}
  getTrafficLightPosition() {
    return { x: 0, y: 0 };
  }
  setWindowButtonPosition() {}
  setProgressBar() {}
  setOverlayIcon() {}
  setSkipTaskbar() {}
  setHasShadow() {}
  setRepresentedFilename() {}
  setDocumentEdited() {}
  flashFrame() {}
  moveTop() {}
  getParentWindow() {
    return this.win.opener ? getBrowserWindow(this.win.opener) : null;
  }
  getChildWindows() {
    return [];
  }
  setFrameZoomLevel(level: number) {
    this.webContents.setZoomLevel(level);
  }
  getNativeWindowHandle() {
    return Buffer.alloc(8);
  }
  static getAllWindows() {
    return [getBrowserWindow(window)];
  }
  static getFocusedWindow() {
    const w = (globalThis as { activeWindow?: Window }).activeWindow ?? window;
    return getBrowserWindow(w);
  }
  static fromWebContents(wc: WebContents) {
    return getBrowserWindow(wc.win);
  }
  static fromId(id: number) {
    const wc = webContentsById.get(id);
    return wc ? getBrowserWindow(wc.win) : null;
  }
}

export function getBrowserWindow(win: Window): BrowserWindow {
  let bw = windowsByWin.get(win);
  if (!bw) bw = new BrowserWindow(win);
  return bw;
}

// ---------------------------------------------------------------------------
// Menu

class MenuItem {
  label?: string;
  type?: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  id?: string;
  role?: string;
  accelerator?: string;
  submenu?: Menu;
  click?: MenuTemplateItem["click"];
  constructor(opts: MenuTemplateItem) {
    Object.assign(this, opts);
    this.enabled = opts.enabled !== false;
    this.visible = opts.visible !== false;
    this.checked = !!opts.checked;
    if (opts.submenu) this.submenu = opts.submenu instanceof Menu ? opts.submenu : Menu.buildFromTemplate(opts.submenu as MenuTemplateItem[]);
  }
}

class Menu extends EventEmitter {
  items: MenuItem[] = [];
  static buildFromTemplate(tpl: MenuTemplateItem[]) {
    const m = new Menu();
    for (const t of tpl) m.append(t instanceof MenuItem ? t : new MenuItem(t));
    return m;
  }
  static setApplicationMenu() {}
  static getApplicationMenu() {
    return null;
  }
  static sendActionToFirstResponder() {}
  append(item: MenuItem) {
    this.items.push(item);
  }
  insert(pos: number, item: MenuItem) {
    this.items.splice(pos, 0, item);
  }
  getMenuItemById(id: string): MenuItem | null {
    for (const i of this.items) {
      if (i.id === id) return i;
      const sub = i.submenu?.getMenuItemById(id);
      if (sub) return sub;
    }
    return null;
  }
  private toTemplate(): MenuTemplateItem[] {
    return this.items.map((i) => ({
      label: i.label,
      type: i.type as MenuTemplateItem["type"],
      enabled: i.enabled,
      visible: i.visible,
      checked: i.checked,
      role: i.role,
      accelerator: i.accelerator,
      submenu: i.submenu?.toTemplate(),
      click: i.click ? (_t, w, e) => i.click!(i as unknown as MenuTemplateItem, w, e) : undefined,
    }));
  }
  popup(opts: { x?: number; y?: number; window?: BrowserWindow; callback?: () => void } = {}) {
    const win = opts.window?.win ?? (globalThis as { activeWindow?: Window }).activeWindow ?? window;
    const zoom = Math.pow(1.2, zoomOf(win));
    const x = opts.x !== undefined ? opts.x / zoom : lastPointer.x;
    const y = opts.y !== undefined ? opts.y / zoom : lastPointer.y;
    this.emit("menu-will-show");
    popupMenu(this.toTemplate(), x, y, win.document, () => {
      this.emit("menu-will-close");
      opts.callback?.();
    });
  }
  closePopup() {}
}

const lastPointer = { x: 100, y: 100 };
document.addEventListener(
  "contextmenu",
  (e) => {
    lastPointer.x = e.clientX;
    lastPointer.y = e.clientY;
  },
  true,
);

// ---------------------------------------------------------------------------
// remote.app & friends

const darkQuery = matchMedia("(prefers-color-scheme: dark)");

class NativeTheme extends EventEmitter {
  themeSource = "system";
  constructor() {
    super();
    darkQuery.addEventListener("change", () => this.emit("updated"));
  }
  get shouldUseDarkColors() {
    return darkQuery.matches;
  }
  get shouldUseHighContrastColors() {
    return matchMedia("(forced-colors: active)").matches;
  }
  get shouldUseInvertedColorScheme() {
    return false;
  }
  get inForcedColorsMode() {
    return matchMedia("(forced-colors: active)").matches;
  }
}
const nativeTheme = new NativeTheme();

class App extends EventEmitter {
  getVersion() {
    return appVersion;
  }
  getName() {
    return "Obsidian";
  }
  get name() {
    return "Obsidian";
  }
  getLocale() {
    return navigator.language || "en-US";
  }
  getSystemLocale() {
    return navigator.language || "en-US";
  }
  getPreferredSystemLanguages() {
    return [...(navigator.languages ?? [navigator.language])];
  }
  getLocaleCountryCode() {
    return (navigator.language.split("-")[1] || "US").toUpperCase();
  }
  getPath(name: string) {
    switch (name) {
      case "home":
        return PATHS.home;
      case "appData":
        return PATHS.home + "/.config";
      case "userData":
      case "sessionData":
        return PATHS.userData;
      case "temp":
        return PATHS.temp;
      case "documents":
        return PATHS.documents;
      case "desktop":
        return PATHS.desktop;
      case "downloads":
        return PATHS.downloads;
      case "exe":
        return process.execPath;
      case "logs":
        return PATHS.userData + "/logs";
      default:
        return PATHS.home;
    }
  }
  getAppPath() {
    return "/opt/obsidian/resources/app.asar";
  }
  isPackaged = true;
  isReady() {
    return true;
  }
  whenReady() {
    return Promise.resolve();
  }
  quit() {}
  exit() {}
  relaunch() {
    ipcRenderer.sendSync("relaunch");
  }
  focus() {
    window.focus();
  }
  hide() {}
  show() {}
  setBadgeCount() {
    return true;
  }
  getBadgeCount() {
    return 0;
  }
  addRecentDocument() {}
  clearRecentDocuments() {}
  setAsDefaultProtocolClient() {
    return false;
  }
  isDefaultProtocolClient() {
    return false;
  }
  removeAsDefaultProtocolClient() {
    return false;
  }
  getGPUFeatureStatus() {
    return {};
  }
  getAppMetrics() {
    return [];
  }
  setAppUserModelId() {}
  setAboutPanelOptions() {}
  showAboutPanel() {}
  getLoginItemSettings() {
    return { openAtLogin: false };
  }
  setLoginItemSettings() {}
  requestSingleInstanceLock() {
    return true;
  }
  isAccessibilitySupportEnabled() {
    return false;
  }
  commandLine = { hasSwitch: () => false, getSwitchValue: () => "", appendSwitch() {}, appendArgument() {} };
  dock = { setBadge() {}, getBadge: () => "", bounce: () => 0, cancelBounce() {}, setMenu() {}, setIcon() {}, show: async () => {}, hide() {}, isVisible: () => true };
}
const app = new App();

const screenApi = {
  getPrimaryDisplay: () => display(),
  getAllDisplays: () => [display()],
  getDisplayNearestPoint: () => display(),
  getDisplayMatching: () => display(),
  getCursorScreenPoint: () => ({ x: lastPointer.x + window.screenX, y: lastPointer.y + window.screenY }),
  on() {},
  removeListener() {},
};

function display() {
  const bounds = { x: 0, y: 0, width: screen.width, height: screen.height };
  return {
    id: 1,
    bounds,
    workArea: { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight },
    size: { width: screen.width, height: screen.height },
    workAreaSize: { width: screen.availWidth, height: screen.availHeight },
    scaleFactor: devicePixelRatio,
    rotation: 0,
    internal: true,
    touchSupport: "unknown",
  };
}

const systemPreferences = {
  getUserDefault: (key: string, type: string) => {
    if (key === "AppleShowScrollBars") return "WhenScrolling";
    if (key === "AppleActionOnDoubleClick") return "Maximize";
    return type === "boolean" ? false : type === "integer" || type === "float" ? 0 : "";
  },
  getAccentColor: () => "",
  getColor: () => "#000000",
  getSystemColor: () => "#007aff",
  isDarkMode: () => darkQuery.matches,
  getAnimationSettings: () => ({ shouldRenderRichAnimation: !matchMedia("(prefers-reduced-motion: reduce)").matches, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches }),
  isAeroGlassEnabled: () => false,
  isTrustedAccessibilityClient: () => false,
  getMediaAccessStatus: () => "granted",
  askForMediaAccess: async () => true,
  on() {},
  removeListener() {},
};

// safeStorage: synchronous encryption with a per-browser random key (AES-like stream via
// SHA-256 counter mode). Protects secrets at rest from casual inspection only.
import { sha256 } from "@noble/hashes/sha2.js";

function storageKey(): Uint8Array {
  let k = localStorage.getItem("o4w-safe-key");
  if (!k) {
    k = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    localStorage.setItem("o4w-safe-key", k);
  }
  return Buffer.from(k, "base64");
}

function keystream(key: Uint8Array, iv: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  const block = new Uint8Array(key.length + iv.length + 4);
  block.set(key, 0);
  block.set(iv, key.length);
  for (let i = 0, ctr = 0; i < len; ctr++) {
    new DataView(block.buffer).setUint32(key.length + iv.length, ctr);
    const h = sha256(block);
    for (let j = 0; j < h.length && i < len; j++, i++) out[i] = h[j];
  }
  return out;
}

const safeStorage = {
  isEncryptionAvailable: () => true,
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => "browser",
  encryptString(plain: string) {
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const data = Buffer.from(plain, "utf8");
    const ks = keystream(storageKey(), iv, data.length);
    for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
    return Buffer.concat([Buffer.from("o4w1"), Buffer.from(iv), data]);
  },
  decryptString(enc: Uint8Array) {
    const b = Buffer.from(enc);
    if (b.subarray(0, 4).toString() !== "o4w1") throw new Error("Unable to decrypt");
    const iv = b.subarray(4, 20);
    const data = Buffer.from(b.subarray(20));
    const ks = keystream(storageKey(), iv, data.length);
    for (let i = 0; i < data.length; i++) data[i] ^= ks[i];
    return data.toString("utf8");
  },
  setUsePlainTextEncryption() {},
};

const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleState: () => "active",
  getSystemIdleTime: () => 0,
  isOnBatteryPower: () => false,
  onBatteryPower: false,
});

const netApi = {
  isOnline: () => navigator.onLine,
  get online() {
    return navigator.onLine;
  },
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
};

const webUtils = {
  getPathForFile(file: File): string {
    return registerExternalFile(file);
  },
};

/** Make a dropped/pasted File readable by path (Obsidian copies it into the vault). */
const fileRefs = new WeakMap<File, string>();
export function registerExternalFile(file: File): string {
  const existing = fileRefs.get(file);
  if (existing) return existing;
  const dir = `${PATHS.temp}/dropped/${Math.random().toString(36).slice(2, 10)}`;
  const path = `${dir}/${file.name || "file"}`;
  vfs.mkdir(dir, true);
  vfs.createLazyFile(path, file.size, file.lastModified, async () => new Uint8Array(await file.arrayBuffer()));
  fileRefs.set(file, path);
  return path;
}

// ---------------------------------------------------------------------------
// Assemble per-window electron module

export function createElectron(win: Window) {
  const bw = () => getBrowserWindow(win);
  const remote = {
    app,
    dialog,
    shell,
    clipboard,
    nativeImage,
    nativeTheme,
    screen: screenApi,
    systemPreferences,
    safeStorage,
    powerMonitor,
    net: netApi,
    session: { defaultSession: session, fromPartition: () => session },
    Menu,
    MenuItem,
    BrowserWindow,
    webContents: {
      fromId: (id: number) => webContentsById.get(id) ?? null,
      getAllWebContents: () => [...webContentsById.values()],
      getFocusedWebContents: () => bw().webContents,
    },
    getCurrentWindow: () => {
      currentWin = win;
      return bw();
    },
    getCurrentWebContents: () => {
      currentWin = win;
      return bw().webContents;
    },
    getGlobal: (name: string) => (window as unknown as Record<string, unknown>)[name],
    process,
    require: (m: string) => (win as unknown as { require(m: string): unknown }).require(m),
    ipcMain: { on() {}, handle() {}, removeHandler() {} },
    globalShortcut: { register: () => false, unregister() {}, unregisterAll() {}, isRegistered: () => false },
    Notification: class {
      constructor(readonly opts: { title: string; body?: string }) {}
      static isSupported() {
        return "Notification" in window;
      }
      show() {
        if ("Notification" in window && Notification.permission === "granted") new Notification(this.opts.title, { body: this.opts.body });
      }
      on() {}
      close() {}
    },
    Tray: class {
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    autoUpdater: { on() {}, checkForUpdates() {}, quitAndInstall() {}, setFeedURL() {} },
    crashReporter: { start() {}, addExtraParameter() {} },
    desktopCapturer: { getSources: async () => [] },
    contentTracing: {},
    protocol: { handle() {}, registerSchemesAsPrivileged() {} },
  };
  const webFrame = {
    getZoomLevel: () => zoomOf(win),
    setZoomLevel: (l: number) => applyZoom(win, l),
    getZoomFactor: () => Math.pow(1.2, zoomOf(win)),
    setZoomFactor: (f: number) => applyZoom(win, Math.log(f) / Math.log(1.2)),
    setVisualZoomLevelLimits() {},
    setSpellCheckProvider() {},
    insertCSS: (css: string) => {
      const s = win.document.createElement("style");
      s.textContent = css;
      win.document.head.appendChild(s);
      return String(Math.random());
    },
    removeInsertedCSS() {},
    executeJavaScript: async (code: string) => (win as unknown as { eval(c: string): unknown }).eval(code),
    getResourceUsage: () => ({}),
    clearCache() {},
  };
  return {
    ipcRenderer: new Proxy(ipcRenderer, {
      get(target, prop, recv) {
        if (prop === "sendSync" || prop === "send" || prop === "invoke") {
          return (...args: unknown[]) => {
            currentWin = win;
            return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }),
    remote,
    webFrame,
    clipboard,
    shell,
    nativeImage,
    webUtils,
    contextBridge: { exposeInMainWorld: (k: string, v: unknown) => ((win as unknown as Record<string, unknown>)[k] = v) },
    crashReporter: remote.crashReporter,
    deprecate: { setHandler() {}, getHandler: () => null },
  };
}

export { isNavigating };

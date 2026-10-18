// <webview> (Electron) replacement used by Obsidian's Web viewer and canvas link embeds.
// Pages are loaded through the proxy in "page mode" inside a sandboxed iframe (opaque
// origin, so pages can never touch our storage); a bridge script in the page reports
// navigation, title and favicons, and executes requests such as executeJavaScript.

import { EventEmitter } from "events";
import { pageProxyUrl, proxyCaps } from "../common/proxy-client";
import { registerWebContents } from "./electron/renderer";

export const TAG = "o4w-webview";
const SANDBOX = "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";
// Direct (unproxied) frames keep their real, foreign origin, so the page can work normally
// without ever being same-origin with us.
const SANDBOX_DIRECT = SANDBOX + " allow-same-origin";

export function defineWebview(win: Window): void {
  const w = win as Window & typeof globalThis;
  if (w.customElements.get(TAG)) return;
  // Custom element names need a dash, so createElement("webview") is redirected.
  const proto = w.Document.prototype;
  const create = proto.createElement;
  proto.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
    return create.call(this, typeof tag === "string" && tag.toLowerCase() === "webview" ? TAG : tag, opts);
  } as typeof proto.createElement;

  class WebviewElement extends w.HTMLElement {
    private frame: HTMLIFrameElement;
    private history: string[] = [];
    private index = -1;
    private currentUrl = "";
    private pageTitle = "";
    private loading = false;
    private gotBridge = false;
    private zoom = 1;
    private seq = 0;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    private contents: EventEmitter & Record<string, unknown>;
    private readonly contentsId: number;
    private readonly onMessage = (e: MessageEvent) => this.handleMessage(e);
    allowpopups = false;
    partition = "";

    constructor() {
      super();
      this.frame = w.document.createElement("iframe");
      this.frame.setAttribute("sandbox", SANDBOX);
      this.frame.setAttribute("allow", "fullscreen; clipboard-write; autoplay");
      this.frame.setAttribute("referrerpolicy", "no-referrer");
      this.frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:white";
      this.frame.addEventListener("load", () => this.onFrameLoad());
      const contents = new EventEmitter() as EventEmitter & Record<string, unknown>;
      Object.assign(contents, {
        isDestroyed: () => !this.isConnected,
        setWindowOpenHandler() {},
        getURL: () => this.currentUrl,
        getTitle: () => this.pageTitle,
        executeJavaScript: (code: string) => this.executeJavaScript(code),
        setZoomFactor: (f: number) => this.setZoomFactor(f),
        getZoomFactor: () => this.zoom,
        setAudioMuted() {},
        isAudioMuted: () => false,
        setUserAgent() {},
        getUserAgent: () => navigator.userAgent,
        focus: () => this.frame.focus(),
        session: { on() {}, webRequest: { onBeforeRequest() {} } },
      });
      this.contents = contents;
      this.contentsId = registerWebContents(contents);
    }

    static get observedAttributes() {
      return ["src"];
    }

    connectedCallback() {
      this.style.display ||= "flex";
      if (!this.frame.isConnected) this.appendChild(this.frame);
      w.addEventListener("message", this.onMessage);
      const src = this.getAttribute("src");
      if (src && !this.currentUrl) this.navigate(src, true);
    }

    disconnectedCallback() {
      w.removeEventListener("message", this.onMessage);
    }

    attributeChangedCallback(name: string, _old: string | null, value: string | null) {
      if (name === "src" && value && value !== this.currentUrl && this.isConnected) this.navigate(value, true);
    }

    get src() {
      return this.currentUrl;
    }
    set src(v: string) {
      this.setAttribute("src", v);
    }

    private fire(type: string, props: Record<string, unknown> = {}) {
      const ev = new w.Event(type);
      Object.assign(ev, props);
      this.dispatchEvent(ev);
    }

    private navigate(url: string, push: boolean) {
      if (!/^https?:/i.test(url)) {
        if (url === "about:blank") {
          this.frame.removeAttribute("src");
          return;
        }
        try {
          url = new URL(url).href;
        } catch {
          return;
        }
      }
      if (push) {
        this.history = this.history.slice(0, this.index + 1);
        this.history.push(url);
        this.index = this.history.length - 1;
      }
      this.currentUrl = url;
      this.loading = true;
      this.gotBridge = false;
      this.fire("did-start-navigation", { url, isMainFrame: true, isInPlace: false });
      this.fire("did-start-loading");
      if (proxyCaps().webviewer) {
        this.frame.setAttribute("sandbox", SANDBOX);
        this.frame.src = pageProxyUrl(url);
      } else {
        // No proxy: frame the site directly (works for sites that allow being framed).
        if (new URL(url).origin === location.origin) return;
        this.frame.setAttribute("sandbox", SANDBOX_DIRECT);
        this.frame.src = url;
      }
    }

    private onFrameLoad() {
      if (!this.frame.getAttribute("src")) return;
      if (!this.gotBridge) {
        // Non-HTML content (PDF, image…) or an error page: no bridge messages.
        this.fire("dom-ready");
        this.fire("did-finish-load");
      }
      this.loading = false;
      this.fire("did-stop-loading");
    }

    private handleMessage(e: MessageEvent) {
      if (e.source !== this.frame.contentWindow) return;
      const m = e.data as Record<string, unknown>;
      if (m?.o4wWebviewReply) {
        const p = this.pending.get(m.id as number);
        if (p) {
          this.pending.delete(m.id as number);
          if (m.error) p.reject(new Error(String(m.error)));
          else p.resolve(m.result);
        }
        return;
      }
      if (!m?.o4wWebview) return;
      switch (m.type) {
        case "dom-ready":
          this.gotBridge = true;
          if (typeof m.url === "string" && m.url !== this.currentUrl) {
            // Redirect.
            this.currentUrl = m.url;
            this.history[this.index] = m.url;
            this.fire("did-redirect-navigation", { url: m.url, isMainFrame: true });
          }
          this.fire("did-navigate", { url: this.currentUrl });
          if (this.zoom !== 1) this.command("zoom", { factor: this.zoom }).catch(() => {});
          this.fire("dom-ready");
          break;
        case "page-title-updated":
          this.pageTitle = String(m.title ?? "");
          this.fire("page-title-updated", { title: this.pageTitle, explicitSet: true });
          break;
        case "page-favicon-updated":
          this.fire("page-favicon-updated", { favicons: m.favicons ?? [] });
          break;
        case "did-finish-load":
          this.fire("did-finish-load");
          break;
        case "did-navigate-in-page":
          this.currentUrl = String(m.url);
          this.history[this.index] = this.currentUrl;
          this.fire("did-navigate-in-page", { url: this.currentUrl, isMainFrame: true });
          break;
        case "navigate":
          this.navigate(String(m.url), true);
          break;
        case "new-window":
          this.fire("new-window", { url: m.url, disposition: "foreground-tab" });
          w.open(String(m.url), "_blank", "noopener");
          break;
      }
    }

    private command(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (!this.gotBridge) return Promise.reject(new Error("This page can't be scripted (opened without the proxy, or not an HTML page)"));
      const target = this.frame.contentWindow;
      if (!target) return Promise.reject(new Error("webview not ready"));
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        target.postMessage({ o4wWebviewCmd: 1, id, cmd, ...args }, "*");
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error("webview did not respond"));
        }, 10000);
      });
    }

    // --- Electron webview API -------------------------------------------------
    loadURL(url: string) {
      this.navigate(url, true);
      return Promise.resolve();
    }
    getURL() {
      return this.currentUrl;
    }
    getTitle() {
      return this.pageTitle || this.currentUrl;
    }
    isLoading() {
      return this.loading;
    }
    isLoadingMainFrame() {
      return this.loading;
    }
    isWaitingForResponse() {
      return false;
    }
    stop() {
      this.loading = false;
      try {
        this.frame.contentWindow?.stop();
      } catch {
        /* cross-origin */
      }
    }
    reload() {
      this.navigate(this.currentUrl, false);
    }
    reloadIgnoringCache() {
      this.reload();
    }
    canGoBack() {
      return this.index > 0;
    }
    canGoForward() {
      return this.index < this.history.length - 1;
    }
    canGoToOffset(o: number) {
      const i = this.index + o;
      return i >= 0 && i < this.history.length;
    }
    goBack() {
      if (this.canGoBack()) this.navigate(this.history[--this.index], false);
    }
    goForward() {
      if (this.canGoForward()) this.navigate(this.history[++this.index], false);
    }
    goToIndex(i: number) {
      if (i >= 0 && i < this.history.length) {
        this.index = i;
        this.navigate(this.history[i], false);
      }
    }
    goToOffset(o: number) {
      this.goToIndex(this.index + o);
    }
    clearHistory() {
      this.history = this.currentUrl ? [this.currentUrl] : [];
      this.index = this.history.length - 1;
    }
    executeJavaScript(code: string) {
      return this.command("exec", { code });
    }
    insertCSS(css: string) {
      return this.command("css", { css }).then(() => String(this.seq));
    }
    removeInsertedCSS() {
      return Promise.resolve();
    }
    setZoomFactor(f: number) {
      this.zoom = f;
      this.command("zoom", { factor: f }).catch(() => {});
    }
    getZoomFactor() {
      return this.zoom;
    }
    setZoomLevel(l: number) {
      this.setZoomFactor(Math.pow(1.2, l));
    }
    getZoomLevel() {
      return Math.log(this.zoom) / Math.log(1.2);
    }
    findInPage(text: string, opts?: { forward?: boolean; matchCase?: boolean }) {
      const id = this.seq + 1;
      this.command("find", { text, matchCase: opts?.matchCase, backwards: opts?.forward === false }).then(
        (found) => this.fire("found-in-page", { result: { requestId: id, activeMatchOrdinal: found ? 1 : 0, matches: found ? 1 : 0, finalUpdate: true } }),
        () => {},
      );
      return id;
    }
    stopFindInPage() {}
    getWebContentsId() {
      return this.contentsId;
    }
    getWebContents() {
      return this.contents;
    }
    openDevTools() {}
    closeDevTools() {}
    isDevToolsOpened() {
      return false;
    }
    setAudioMuted() {}
    isAudioMuted() {
      return false;
    }
    isCurrentlyAudible() {
      return false;
    }
    getUserAgent() {
      return navigator.userAgent;
    }
    setUserAgent() {}
    print() {
      return Promise.resolve();
    }
    printToPDF() {
      return Promise.resolve(new Uint8Array(0));
    }
    capturePage() {
      return Promise.resolve(null);
    }
    send() {}
    sendInputEvent() {}
    insertText() {
      return Promise.resolve();
    }
    undo() {}
    redo() {}
    cut() {}
    copy() {}
    paste() {}
    selectAll() {}
    unselect() {}
    focus() {
      this.frame.focus();
    }
  }

  w.customElements.define(TAG, WebviewElement);
}

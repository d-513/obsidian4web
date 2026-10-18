// Networking: Electron's net.request (behind Obsidian's requestUrl) and CORS workarounds for
// fetch / XMLHttpRequest / WebSocket. The proxy is used when the server offers one and allows
// the destination; otherwise requests go direct (and only CORS-enabled hosts will work).

import { WS_PROXY_PREFIX } from "../../common/config";
import { ProxyError, proxyAllows, proxyCaps, proxyFetch, ensureSession } from "../../common/proxy-client";

/** Hosts that never send CORS headers for our origin, or that check the Origin header. */
const PREFER_PROXY = [/(^|\.)obsidian\.md$/i, /^github\.com$/i, /^objects\.githubusercontent\.com$/i, /^release-assets\.githubusercontent\.com$/i];

function isCrossOriginHttp(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin;
}

export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array | null;
  contentType?: string;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

let nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k] = v));
  return out;
}

/** Node-like request (no CORS limits when proxied). Used for Obsidian's requestUrl. */
export async function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const method = (req.method || "GET").toUpperCase();
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.contentType) headers["Content-Type"] = req.contentType;
  const body = method === "GET" || method === "HEAD" ? undefined : ((req.body ?? null) as BodyInit | null);

  if (proxyAllows(req.url)) {
    try {
      const res = await proxyFetch(req.url, { method, headers, body }, nativeFetch);
      const raw = res.headers.get("X-O4W-Response-Headers");
      return {
        status: Number(res.headers.get("X-O4W-Status") || res.status),
        headers: raw ? JSON.parse(decodeURIComponent(raw)) : headersToRecord(res.headers),
        body: await res.arrayBuffer(),
      };
    } catch (e) {
      // Destination refused by the proxy's policy: still try directly below.
      if (!(e instanceof ProxyError && e.status === 403)) throw e;
    }
  }
  try {
    const res = await nativeFetch(req.url, { method, headers, body, credentials: "omit", redirect: "follow" });
    return { status: res.status, headers: headersToRecord(res.headers), body: await res.arrayBuffer() };
  } catch (e) {
    const host = (() => {
      try {
        return new URL(req.url).host;
      } catch {
        return req.url;
      }
    })();
    const why = proxyCaps().proxy ? "this server's proxy doesn't allow it" : "this site has no proxy";
    throw new Error(`Request to ${host} was blocked by the browser (CORS) and ${why}. (${(e as Error).message})`);
  }
}

// ---------------------------------------------------------------------------
// fetch / XHR / WebSocket patches

async function viaProxy(req: Request, url: URL): Promise<Response> {
  const headers = headersToRecord(req.headers);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const res = await proxyFetch(url.href, { method: req.method, headers, body, signal: req.signal }, nativeFetch);
  // Rebuild a response that looks like the upstream one.
  const raw = res.headers.get("X-O4W-Response-Headers");
  const status = Number(res.headers.get("X-O4W-Status") || res.status);
  const nullBody = status === 204 || status === 205 || status === 304 || status < 200;
  return new Response(nullBody ? null : res.body, {
    status: status >= 200 && status <= 599 ? status : 200,
    headers: raw ? JSON.parse(decodeURIComponent(raw)) : res.headers,
  });
}

export function patchNetwork(win: Window & typeof globalThis): void {
  const w = win as unknown as Record<string, unknown>;
  if (w.__o4wNetPatched) return;
  w.__o4wNetPatched = true;
  const origFetch = win.fetch.bind(win);
  if (win === window) nativeFetch = origFetch;

  win.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), win.location.href);
    } catch {
      return origFetch(input, init);
    }
    if (!isCrossOriginHttp(url) || !proxyAllows(url)) return origFetch(input, init);
    const req = new Request(input, init);
    if (PREFER_PROXY.some((re) => re.test(url.hostname))) return viaProxy(req, url);
    const retry = req.method === "GET" || req.method === "HEAD" ? req.clone() : null;
    try {
      return await origFetch(req);
    } catch (e) {
      if (!retry || (e as Error).name === "AbortError") throw e;
      return viaProxy(retry, url);
    }
  } as typeof fetch;

  const XHR = win.XMLHttpRequest;
  const open = XHR.prototype.open;
  const send = XHR.prototype.send;
  XHR.prototype.open = function (this: XMLHttpRequest & { __o4wProxied?: boolean }, method: string, url: string | URL, ...rest: unknown[]) {
    this.__o4wProxied = false;
    try {
      const u = new URL(String(url), win.location.href);
      if (isCrossOriginHttp(u) && proxyAllows(u) && PREFER_PROXY.some((re) => re.test(u.hostname))) {
        url = `/__proxy?url=${encodeURIComponent(u.href)}`;
        this.__o4wProxied = true;
      }
    } catch {
      /* ignore */
    }
    const r = (open as (...a: unknown[]) => void).call(this, method, url, ...(rest.length ? rest : [true]));
    if (this.__o4wProxied) this.setRequestHeader("X-O4W-Proxy", "1");
    return r;
  } as typeof XHR.prototype.open;
  XHR.prototype.send = function (this: XMLHttpRequest & { __o4wProxied?: boolean }, body?: Document | XMLHttpRequestBodyInit | null) {
    if (this.__o4wProxied) {
      // Make sure the session cookie exists before the first proxied XHR.
      void ensureSession().then(() => send.call(this, body as XMLHttpRequestBodyInit));
      return;
    }
    return send.call(this, body as XMLHttpRequestBodyInit);
  };

  const NativeWS = win.WebSocket;
  class ProxiedWebSocket extends NativeWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      let target = String(url);
      try {
        const u = new URL(target);
        const asHttp = new URL(u.href.replace(/^ws/, "http"));
        if (u.host !== win.location.host && proxyAllows(asHttp) && PREFER_PROXY.some((re) => re.test(u.hostname))) {
          const scheme = win.location.protocol === "https:" ? "wss:" : "ws:";
          target = `${scheme}//${win.location.host}${WS_PROXY_PREFIX}?url=${encodeURIComponent(u.href)}`;
        }
      } catch {
        /* ignore */
      }
      super(target, protocols);
    }
  }
  w.WebSocket = ProxiedWebSocket;
}

export { nativeFetch };

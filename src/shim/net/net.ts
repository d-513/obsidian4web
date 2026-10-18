// Networking: Electron's net.request (used by Obsidian's requestUrl) and CORS workarounds
// for fetch / XMLHttpRequest / WebSocket, all via our same-origin proxy.

import { PROXY_PREFIX, WS_PROXY_PREFIX } from "../../common/config";

/** Hosts that never send CORS headers for our origin (or check the Origin). */
const ALWAYS_PROXY = [/(^|\.)obsidian\.md$/i, /^github\.com$/i, /^objects\.githubusercontent\.com$/i, /^release-assets\.githubusercontent\.com$/i];

export function proxyUrl(url: string): string {
  return PROXY_PREFIX + "?url=" + encodeURIComponent(url);
}

function isCrossOriginHttp(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== location.origin;
}

function mustProxy(url: URL): boolean {
  return ALWAYS_PROXY.some((re) => re.test(url.hostname));
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

/** Perform a request through the proxy with Node-like semantics (no CORS, any header). */
export async function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.contentType) headers["Content-Type"] = req.contentType;
  const res = await nativeFetch(proxyUrl(req.url), {
    method: req.method || "GET",
    headers: { "X-O4W-Headers": encodeHeaders(headers) },
    body: req.method && req.method !== "GET" && req.method !== "HEAD" ? (req.body as BodyInit | null) ?? null : undefined,
    redirect: "follow",
    credentials: "omit",
  });
  if (res.status === 599) {
    throw new Error((await res.text()) || "net::ERR_FAILED");
  }
  const out: Record<string, string> = {};
  const raw = res.headers.get("X-O4W-Response-Headers");
  if (raw) {
    Object.assign(out, JSON.parse(decodeURIComponent(raw)));
  } else {
    res.headers.forEach((v, k) => (out[k] = v));
  }
  const status = Number(res.headers.get("X-O4W-Status") || res.status);
  return { status, headers: out, body: await res.arrayBuffer() };
}

function encodeHeaders(h: Record<string, string>): string {
  return encodeURIComponent(JSON.stringify(h));
}

// ---------------------------------------------------------------------------
// fetch / XHR / WebSocket patches

let nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

function toProxiedRequest(input: Request, url: URL): Request {
  const headers: Record<string, string> = {};
  input.headers.forEach((v, k) => (headers[k] = v));
  return new Request(proxyUrl(url.href), {
    method: input.method,
    headers: { "X-O4W-Headers": encodeHeaders(headers) },
    body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body,
    redirect: "follow",
    credentials: "omit",
    signal: input.signal,
    // @ts-expect-error duplex is required for streaming bodies in Chromium
    duplex: "half",
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
    if (!isCrossOriginHttp(url)) return origFetch(input, init);
    const req = new Request(input, init);
    if (mustProxy(url)) return origFetch(toProxiedRequest(req, url));
    const retry = req.method === "GET" || req.method === "HEAD" ? req.clone() : null;
    try {
      return await origFetch(req);
    } catch (e) {
      if (!retry || (e as Error).name === "AbortError") throw e;
      return origFetch(toProxiedRequest(retry, url));
    }
  } as typeof fetch;

  const XHR = win.XMLHttpRequest;
  const open = XHR.prototype.open;
  XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      const u = new URL(String(url), win.location.href);
      if (isCrossOriginHttp(u) && mustProxy(u)) url = proxyUrl(u.href);
    } catch {
      /* ignore */
    }
    return (open as (...a: unknown[]) => void).call(this, method, url, ...(rest.length ? rest : [true]));
  } as typeof XHR.prototype.open;

  const NativeWS = win.WebSocket;
  class ProxiedWebSocket extends NativeWS {
    constructor(url: string | URL, protocols?: string | string[]) {
      let target = String(url);
      try {
        const u = new URL(target);
        if (u.host !== win.location.host && ALWAYS_PROXY.some((re) => re.test(u.hostname))) {
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

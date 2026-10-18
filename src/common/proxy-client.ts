// Client side of the proxy: capability detection, session handling and request helpers.
// Works without any proxy (static hosting): everything then goes direct, subject to CORS.

import { PROXY_PREFIX } from "./config";

export interface ProxyCaps {
  proxy: boolean;
  mode: "allowlist" | "open" | "off" | "none";
  webviewer: boolean;
  allowHosts: string[] | null;
}

const NO_PROXY: ProxyCaps = { proxy: false, mode: "none", webviewer: false, allowHosts: [] };
const CACHE_KEY = "o4w-proxy-caps";

let caps: ProxyCaps = readCached() ?? NO_PROXY;
let detecting: Promise<ProxyCaps> | null = null;

function readCached(): ProxyCaps | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as ProxyCaps) : null;
  } catch {
    return null;
  }
}

/** Ask the server what it offers. Static hosts answer with 404 or HTML → no proxy. */
export function detectProxy(force = false): Promise<ProxyCaps> {
  if (detecting && !force) return detecting;
  detecting = (async () => {
    try {
      const res = await fetch(PROXY_PREFIX + "/health", { cache: "no-store" });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !type.includes("application/json")) throw new Error(`health check answered ${res.status} ${type}`);
      const body = (await res.json()) as Partial<ProxyCaps>;
      caps = {
        proxy: !!body.proxy,
        mode: (body.mode as ProxyCaps["mode"]) ?? "none",
        webviewer: !!body.webviewer,
        allowHosts: body.allowHosts ?? null,
      };
    } catch (e) {
      console.info("[o4w] no proxy available:", (e as Error)?.message ?? e);
      caps = NO_PROXY;
    }
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(caps));
    } catch {
      /* ignore */
    }
    return caps;
  })();
  return detecting;
}

export function proxyCaps(): ProxyCaps {
  return caps;
}

function hostMatches(host: string, patterns: string[]): boolean {
  host = host.toLowerCase();
  return patterns.some((p) => (p.startsWith(".") ? host.endsWith(p) : host === p));
}

/** Whether the proxy would accept this destination. */
export function proxyAllows(url: string | URL): boolean {
  if (!caps.proxy) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (caps.mode === "open" || caps.allowHosts === null) return true;
  return hostMatches(u.hostname, caps.allowHosts);
}

let session: Promise<boolean> | null = null;

/** Obtain the session cookie the proxy requires (HttpOnly, set by the server). */
export function ensureSession(force = false): Promise<boolean> {
  if (session && !force) return session;
  session = fetch(PROXY_PREFIX + "/session", { method: "POST", credentials: "same-origin", cache: "no-store" })
    .then((r) => r.ok)
    .catch(() => false);
  return session;
}

export function pageProxyUrl(url: string): string {
  return `${PROXY_PREFIX}?mode=page&url=${encodeURIComponent(url)}`;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Send a request through the proxy. Headers are passed in X-O4W-Headers so that headers
 * browsers forbid (User-Agent, Cookie…) still reach the destination, like Node would.
 */
export async function proxyFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  const send = () =>
    fetchImpl(`${PROXY_PREFIX}?url=${encodeURIComponent(url)}`, {
      method,
      headers: { "X-O4W-Proxy": "1", "X-O4W-Headers": encodeURIComponent(JSON.stringify(init.headers ?? {})) },
      body: method === "GET" || method === "HEAD" ? undefined : init.body,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
      // @ts-expect-error required by Chromium for streaming request bodies
      duplex: "half",
    });
  await ensureSession();
  let res = await send();
  if (res.status === 401 && res.headers.get("X-O4W-Error")) {
    await ensureSession(true);
    res = await send();
  }
  if (res.headers.get("X-O4W-Error")) {
    throw new ProxyError((await res.text()) || `Proxy error ${res.status}`, res.status);
  }
  return res;
}

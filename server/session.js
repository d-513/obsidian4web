// Short-lived signed session cookie that the site hands out to its own pages.
// The proxy requires it, so the relay can't be used by simply pointing a script at it,
// and rate limits apply per session as well as per IP.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const COOKIE = "o4w_session";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export function createSessions(config) {
  const sign = (payload) => b64url(createHmac("sha256", config.secret).update(payload).digest());

  function issue() {
    const payload = b64url(JSON.stringify({ id: randomBytes(9).toString("base64url"), exp: Date.now() + config.tokenTtlMs }));
    return `${payload}.${sign(payload)}`;
  }

  /** Returns the session id, or null if missing/invalid/expired. */
  function verify(token) {
    if (!token || typeof token !== "string") return null;
    const [payload, mac] = token.split(".");
    if (!payload || !mac) return null;
    const expected = Buffer.from(sign(payload));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (typeof data.exp !== "number" || data.exp < Date.now()) return null;
      return String(data.id);
    } catch {
      return null;
    }
  }

  function fromRequest(req) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === COOKIE) return verify(v.join("="));
    }
    return null;
  }

  function cookieHeader(secure) {
    const maxAge = Math.floor(config.tokenTtlMs / 1000);
    return `${COOKIE}=${issue()}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
  }

  return { issue, verify, fromRequest, cookieHeader };
}

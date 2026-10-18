// Runtime configuration (environment variables). See README "Deploying".
import { randomBytes } from "node:crypto";

function list(v) {
  return (v || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Destinations Obsidian itself needs: its own services and GitHub (app, plugins, themes). */
export const DEFAULT_ALLOWED_HOSTS = [
  "obsidian.md",
  ".obsidian.md",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
];

export function loadConfig(env = process.env) {
  const mode = (env.O4W_PROXY_MODE || "allowlist").toLowerCase();
  if (!["allowlist", "open", "off"].includes(mode)) throw new Error(`Invalid O4W_PROXY_MODE: ${mode}`);
  const secret = env.O4W_SECRET || randomBytes(32).toString("hex");
  return {
    /** "allowlist": only DEFAULT_ALLOWED_HOSTS + O4W_PROXY_ALLOW_HOSTS; "open": any public host; "off": no proxy. */
    mode,
    allowHosts: [...DEFAULT_ALLOWED_HOSTS, ...list(env.O4W_PROXY_ALLOW_HOSTS)],
    /** Web viewer pages (any public host, GET only, sandboxed). Defaults to on only in open mode. */
    webviewer: env.O4W_PROXY_WEBVIEWER ? env.O4W_PROXY_WEBVIEWER === "1" : mode === "open",
    allowPrivate: env.O4W_PROXY_ALLOW_PRIVATE === "1",
    /** Origins allowed to use the proxy besides the request's own host (comma-separated). */
    allowedOrigins: list(env.O4W_ALLOWED_ORIGINS),
    /** Trust X-Forwarded-Host/-Proto/-For from a reverse proxy in front of us. */
    trustProxy: env.O4W_TRUST_PROXY === "1",
    secret,
    secretIsEphemeral: !env.O4W_SECRET,
    tokenTtlMs: num(env.O4W_TOKEN_TTL_HOURS, 24) * 3600e3,
    limits: {
      requestsPerMinute: num(env.O4W_RATE_LIMIT_RPM, 300),
      bytesPerHour: num(env.O4W_RATE_LIMIT_MB_PER_HOUR, 2048) * 1048576,
      concurrent: num(env.O4W_MAX_CONCURRENT, 24),
      maxRequestBody: num(env.O4W_MAX_REQUEST_MB, 64) * 1048576,
      maxResponseBody: num(env.O4W_MAX_RESPONSE_MB, 200) * 1048576,
      timeoutMs: num(env.O4W_TIMEOUT_S, 120) * 1000,
      maxRedirects: 5,
      wsPerClient: num(env.O4W_MAX_WEBSOCKETS, 8),
      wsMaxMessage: num(env.O4W_WS_MAX_MESSAGE_MB, 256) * 1048576,
    },
    log: env.O4W_PROXY_LOG === "1",
  };
}

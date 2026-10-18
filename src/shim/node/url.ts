// Node "url" module.

function encodePathChars(p: string): string {
  return p
    .replace(/%/g, "%25")
    .replace(/\\/g, "%5C")
    .replace(/\n/g, "%0A")
    .replace(/\r/g, "%0D")
    .replace(/\t/g, "%09");
}

export function pathToFileURL(p: string): URL {
  let resolved = p.startsWith("/") ? p : "/" + p;
  const u = new URL("file://");
  u.pathname = encodePathChars(resolved);
  return u;
}

export function fileURLToPath(u: string | URL): string {
  const url = typeof u === "string" ? new URL(u) : u;
  if (url.protocol !== "file:") throw new TypeError("The URL must be of scheme file");
  return decodeURIComponent(url.pathname);
}

interface LegacyUrl {
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | Record<string, string> | null;
  pathname: string | null;
  path: string | null;
  href: string;
}

function parse(input: string, parseQuery = false): LegacyUrl {
  try {
    const u = new URL(input);
    const query = u.search ? u.search.slice(1) : null;
    return {
      protocol: u.protocol,
      slashes: true,
      auth: u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null,
      host: u.host || null,
      port: u.port || null,
      hostname: u.hostname || null,
      hash: u.hash || null,
      search: u.search || null,
      query: parseQuery ? Object.fromEntries(u.searchParams) : query,
      pathname: u.pathname || null,
      path: u.pathname + u.search,
      href: u.href,
    };
  } catch {
    const [pathAndQuery, hash] = input.split("#");
    const [pathname, search] = pathAndQuery.split("?");
    return {
      protocol: null,
      slashes: null,
      auth: null,
      host: null,
      port: null,
      hostname: null,
      hash: hash !== undefined ? "#" + hash : null,
      search: search !== undefined ? "?" + search : null,
      query: parseQuery ? Object.fromEntries(new URLSearchParams(search ?? "")) : search ?? null,
      pathname,
      path: pathAndQuery,
      href: input,
    };
  }
}

function format(u: string | URL | Partial<LegacyUrl>): string {
  if (typeof u === "string") return u;
  if (u instanceof URL) return u.href;
  let out = "";
  if (u.protocol) out += u.protocol.endsWith(":") ? u.protocol : u.protocol + ":";
  if (u.slashes || u.host || u.hostname) out += "//";
  if (u.auth) out += u.auth + "@";
  out += u.host ?? (u.hostname ? u.hostname + (u.port ? ":" + u.port : "") : "");
  out += u.pathname ?? "";
  if (u.search) out += u.search;
  else if (u.query && typeof u.query === "object") out += "?" + new URLSearchParams(u.query).toString();
  if (u.hash) out += u.hash;
  return out;
}

function resolve(from: string, to: string): string {
  return new URL(to, new URL(from, "resolve://")).href.replace(/^resolve:\/\//, "");
}

export const url = {
  URL,
  URLSearchParams,
  pathToFileURL,
  fileURLToPath,
  parse,
  format,
  resolve,
  domainToASCII: (d: string) => new URL("http://" + d).hostname,
  domainToUnicode: (d: string) => d,
};

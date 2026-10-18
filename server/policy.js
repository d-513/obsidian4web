// Destination policy for the proxy: host allowlist and SSRF protection.
//
// Private-address checks happen at connect time (custom DNS lookup), so they also cover
// redirects and DNS rebinding; the allowlist is checked for every redirect hop.

import dns from "node:dns";
import { isIP } from "node:net";

export class PolicyError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.status = status;
  }
}

export function hostMatches(host, patterns) {
  host = host.toLowerCase().replace(/\.+$/, "");
  return patterns.some((p) => (p.startsWith(".") ? host.endsWith(p) : host === p));
}

function ipv4ToInt(ip) {
  return ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}

const V4_BLOCKS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateIpv4Int(n) {
  return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask));
}

/** Parse a validated IPv6 string into 8 16-bit words, or null if malformed/scoped. */
function parseIpv6Words(ip) {
  if (ip.includes("%")) return null; // Zone IDs are link-local by definition
  let v = ip.toLowerCase();
  const v4Match = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4Match) {
    const octets = v4Match.slice(1).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    v = v.slice(0, v4Match.index) + `:${hi}:${lo}`;
  }
  const halves = v.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((w) => parseInt(w, 16));
  if (words.length !== 8 || words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) {
    return isPrivateIpv4Int(ipv4ToInt(ip));
  }
  if (family === 6) {
    const w = parseIpv6Words(ip);
    if (!w) return true;
    // IPv4-mapped (::ffff:0:0/96): allow only if the embedded IPv4 address is public.
    if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
      return isPrivateIpv4Int(((w[6] << 16) | w[7]) >>> 0);
    }
    // Only 2000::/3 is IANA Global Unicast (blocks ::1, ::/96 v4-compat, ::ffff:0:0:0/96 SIIT,
    // 64:ff9b:: NAT64, 100::/64 discard, fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast).
    if ((w[0] & 0xe000) !== 0x2000) return true;
    // Special-purpose blocks inside 2000::/3:
    if (w[0] === 0x2001) {
      if (w[1] === 0x0000) return true; // 2001::/32 Teredo
      if (w[1] === 0x0002 && w[2] === 0) return true; // 2001:2::/48 Benchmarking
      if (w[1] === 0x0db8) return true; // 2001:db8::/32 Documentation
      if ((w[1] & 0xfff0) === 0x0010 || (w[1] & 0xfff0) === 0x0020) return true; // ORCHID v1/v2
    }
    if (w[0] === 0x2002) return true; // 2002::/16 6to4 (embeds arbitrary IPv4)
    if ((w[0] & 0xfff0) === 0x3fff) return true; // 3fff::/20 Documentation
    return false;
  }
  return true;
}

export function createPolicy(config) {
  /** DNS lookup used for every outgoing connection; refuses private addresses. */
  function safeLookup(hostname, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      const ok = config.allowPrivate ? list : list.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) {
        const e = new PolicyError(`Refusing to connect to private address for ${hostname}`);
        e.code = "EO4WPRIVATE";
        return callback(e);
      }
      if (options.all) callback(null, ok);
      else callback(null, ok[0].address, ok[0].family);
    });
  }

  /**
   * Validate a destination URL. `kind` is "http", "ws" or "page" (web viewer navigation).
   * Throws PolicyError when not allowed.
   */
  function checkUrl(raw, kind) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      throw new PolicyError("Invalid URL", 400);
    }
    const protocols = kind === "ws" ? ["ws:", "wss:"] : ["http:", "https:"];
    if (!protocols.includes(url.protocol)) throw new PolicyError("Unsupported protocol", 400);
    if (url.username || url.password) throw new PolicyError("Credentials in URL are not allowed", 400);
    if (url.hostname.endsWith(".")) url.hostname = url.hostname.replace(/\.+$/, "");
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host) throw new PolicyError("Invalid URL", 400);
    if (!config.allowPrivate && isIP(host) && isPrivateAddress(host)) {
      throw new PolicyError("Private network destinations are not allowed");
    }
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host) && !config.allowPrivate) {
      throw new PolicyError("Private network destinations are not allowed");
    }
    if (config.mode === "off") throw new PolicyError("Proxy disabled", 404);
    if (config.mode === "open") return url;
    if (kind === "page" && config.webviewer) return url;
    if (!hostMatches(host, config.allowHosts)) {
      throw new PolicyError(`Destination not allowed by this server: ${host}`);
    }
    return url;
  }

  return { safeLookup, checkUrl };
}

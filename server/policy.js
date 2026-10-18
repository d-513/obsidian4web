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
  host = host.toLowerCase().replace(/\.$/, "");
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

export function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(v)) return true; // hex-form mapped v4: refuse
    const first = parseInt(v.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (v.startsWith("64:ff9b:") || v.startsWith("2001:db8:") || v.startsWith("100::")) return true;
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
    const host = url.hostname.replace(/^\[|\]$/g, "");
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

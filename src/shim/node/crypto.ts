// Node "crypto" module (subset): hashes, HMAC, random, scrypt, pbkdf2.
import { Buffer } from "buffer";
import { md5, sha1 } from "@noble/hashes/legacy.js";
import { sha224, sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scrypt as nobleScrypt, scryptAsync } from "@noble/hashes/scrypt.js";
import { pbkdf2 as noblePbkdf2, pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { toBytes } from "./fs";

interface HashState {
  update(d: Uint8Array): unknown;
  digest(): Uint8Array;
  clone(): HashState;
}
type HashFn = ((msg: Uint8Array) => Uint8Array) & { create(): HashState; outputLen: number; blockLen: number };
const HASHES = {
  md5,
  sha1,
  "sha-1": sha1,
  sha224,
  sha256,
  "sha-256": sha256,
  sha384,
  sha512,
  "sha-512": sha512,
} as unknown as Record<string, HashFn>;

function hashFn(name: string): HashFn {
  const fn = HASHES[name.toLowerCase()];
  if (!fn) throw new Error(`Digest method not supported: ${name}`);
  return fn;
}

function output(bytes: Uint8Array, encoding?: BufferEncoding): Buffer | string {
  const b = Buffer.from(bytes);
  return encoding ? b.toString(encoding) : b;
}

class Hash {
  private h: HashState;
  constructor(readonly algorithm: string) {
    this.h = hashFn(algorithm).create();
  }
  update(data: unknown, enc?: BufferEncoding) {
    this.h.update(toBytes(data, enc));
    return this;
  }
  digest(enc?: BufferEncoding) {
    return output(this.h.digest(), enc);
  }
  copy() {
    const c = Object.create(Hash.prototype) as Hash;
    (c as unknown as { h: unknown }).h = this.h.clone();
    return c;
  }
}

class Hmac {
  private h: HashState;
  constructor(algorithm: string, key: unknown) {
    this.h = (hmac.create as unknown as (h: HashFn, k: Uint8Array) => HashState)(hashFn(algorithm), toBytes(key));
  }
  update(data: unknown, enc?: BufferEncoding) {
    this.h.update(toBytes(data, enc));
    return this;
  }
  digest(enc?: BufferEncoding) {
    return output(this.h.digest(), enc);
  }
}

function randomBytes(n: number, cb?: (e: Error | null, b: Buffer) => void): Buffer {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)) as Uint8Array<ArrayBuffer>);
  if (cb) setTimeout(() => cb(null, b), 0);
  return b;
}

interface ScryptOpts {
  N?: number;
  r?: number;
  p?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxmem?: number;
}

function scryptParams(o?: ScryptOpts) {
  return {
    N: o?.N ?? o?.cost ?? 16384,
    r: o?.r ?? o?.blockSize ?? 8,
    p: o?.p ?? o?.parallelization ?? 1,
    maxmem: Math.max(o?.maxmem ?? 0, 2 ** 31),
  };
}

function scrypt(password: unknown, salt: unknown, keylen: number, opts: unknown, cb?: unknown) {
  if (typeof opts === "function") {
    cb = opts;
    opts = undefined;
  }
  const { N, r, p, maxmem } = scryptParams(opts as ScryptOpts);
  scryptAsync(toBytes(password), toBytes(salt), { N, r, p, dkLen: keylen, maxmem }).then(
    (k) => (cb as (e: null, k: Buffer) => void)(null, Buffer.from(k)),
    (e) => (cb as (e: Error) => void)(e),
  );
}

function scryptSync(password: unknown, salt: unknown, keylen: number, opts?: ScryptOpts) {
  const { N, r, p, maxmem } = scryptParams(opts);
  return Buffer.from(nobleScrypt(toBytes(password), toBytes(salt), { N, r, p, dkLen: keylen, maxmem }));
}

function pbkdf2(password: unknown, salt: unknown, iterations: number, keylen: number, digest: string, cb: (e: Error | null, k?: Buffer) => void) {
  pbkdf2Async(hashFn(digest) as never, toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }).then(
    (k) => cb(null, Buffer.from(k)),
    (e) => cb(e),
  );
}

function pbkdf2Sync(password: unknown, salt: unknown, iterations: number, keylen: number, digest: string) {
  return Buffer.from(noblePbkdf2(hashFn(digest) as never, toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }));
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) throw new RangeError("Input buffers must have the same byte length");
  let r = 0;
  for (let i = 0; i < a.byteLength; i++) r |= a[i] ^ b[i];
  return r === 0;
}

export const nodeCrypto = {
  createHash: (alg: string) => new Hash(alg),
  createHmac: (alg: string, key: unknown) => new Hmac(alg, key),
  randomBytes,
  pseudoRandomBytes: randomBytes,
  randomFillSync<T extends ArrayBufferView>(buf: T) {
    crypto.getRandomValues(new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength));
    return buf;
  },
  randomInt(min: number, max?: number) {
    if (max === undefined) {
      max = min;
      min = 0;
    }
    return min + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * (max - min));
  },
  randomUUID: () => crypto.randomUUID(),
  getRandomValues: <T extends ArrayBufferView>(a: T) => crypto.getRandomValues(a as unknown as Uint8Array<ArrayBuffer>) as unknown as T,
  scrypt,
  scryptSync,
  pbkdf2,
  pbkdf2Sync,
  timingSafeEqual,
  getHashes: () => Object.keys(HASHES),
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto.subtle,
  constants: {},
};

// Assorted small Node modules: util, events, buffer, stubs.
import { Buffer } from "buffer";
import { EventEmitter } from "events";

function format(fmt: unknown, ...args: unknown[]): string {
  if (typeof fmt !== "string") return [fmt, ...args].map((a) => inspect(a)).join(" ");
  let i = 0;
  let out = fmt.replace(/%[sdifjoO%]/g, (m) => {
    if (m === "%%") return "%";
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case "%s":
        return String(a);
      case "%d":
      case "%i":
        return String(parseInt(String(a), 10));
      case "%f":
        return String(parseFloat(String(a)));
      case "%j":
        return JSON.stringify(a);
      default:
        return inspect(a);
    }
  });
  for (; i < args.length; i++) out += " " + inspect(args[i]);
  return out;
}

function inspect(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function promisify<T extends (...args: any[]) => void>(fn: T) {
  const custom = (fn as unknown as Record<symbol, unknown>)[promisify.custom];
  if (typeof custom === "function") return custom;
  return (...args: unknown[]) =>
    new Promise((resolve, reject) => {
      fn(...args, (err: unknown, ...res: unknown[]) => (err ? reject(err) : resolve(res.length > 1 ? res : res[0])));
    });
}
promisify.custom = Symbol.for("nodejs.util.promisify.custom");

export const util = {
  format,
  inspect,
  promisify,
  callbackify(fn: (...a: unknown[]) => Promise<unknown>) {
    return (...args: unknown[]) => {
      const cb = args.pop() as (e: unknown, r?: unknown) => void;
      fn(...args).then((r) => cb(null, r), (e) => cb(e));
    };
  },
  inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }) {
    ctor.super_ = superCtor;
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  },
  deprecate<T>(fn: T) {
    return fn;
  },
  isDeepStrictEqual(a: unknown, b: unknown) {
    return JSON.stringify(a) === JSON.stringify(b);
  },
  types: {
    isDate: (v: unknown) => v instanceof Date,
    isRegExp: (v: unknown) => v instanceof RegExp,
    isPromise: (v: unknown) => v instanceof Promise,
    isUint8Array: (v: unknown) => v instanceof Uint8Array,
    isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
    isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  },
  isArray: Array.isArray,
  isString: (v: unknown) => typeof v === "string",
  isFunction: (v: unknown) => typeof v === "function",
  isObject: (v: unknown) => v !== null && typeof v === "object",
  TextEncoder,
  TextDecoder,
};

export const eventsModule = Object.assign(EventEmitter, {
  EventEmitter,
  once(emitter: EventEmitter, name: string) {
    return new Promise((resolve) => emitter.once(name, (...args: unknown[]) => resolve(args)));
  },
  defaultMaxListeners: 10,
});

export const bufferModule = {
  Buffer,
  kMaxLength: 2 ** 31 - 1,
  constants: { MAX_LENGTH: 2 ** 31 - 1 },
  Blob,
  atob,
  btoa,
};

function notSupported(name: string) {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "__esModule") return false;
        if (prop === "then") return undefined;
        return () => {
          const err = new Error(`${name}.${String(prop)} is not available in the browser`) as Error & { code: string };
          err.code = "ENOSYS";
          throw err;
        };
      },
    },
  );
}

export const childProcess = notSupported("child_process");
export const netModule = notSupported("net");

export const timersModule = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate: (fn: (...a: unknown[]) => void, ...args: unknown[]) => setTimeout(fn, 0, ...args),
  clearImmediate: (id: number) => clearTimeout(id),
  promises: {
    setTimeout: (ms: number, v?: unknown) => new Promise((r) => setTimeout(() => r(v), ms)),
    setImmediate: (v?: unknown) => new Promise((r) => setTimeout(() => r(v), 0)),
  },
};

export const stringDecoder = {
  StringDecoder: class {
    private d: TextDecoder;
    constructor(enc = "utf8") {
      this.d = new TextDecoder(enc === "utf8" ? "utf-8" : enc);
    }
    write(b: Uint8Array) {
      return this.d.decode(b, { stream: true });
    }
    end(b?: Uint8Array) {
      return this.d.decode(b);
    }
  },
};

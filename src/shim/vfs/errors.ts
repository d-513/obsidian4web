// Node-compatible filesystem errors.

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, "no such file or directory"],
  EEXIST: [-17, "file already exists"],
  ENOTDIR: [-20, "not a directory"],
  EISDIR: [-21, "illegal operation on a directory"],
  ENOTEMPTY: [-66, "directory not empty"],
  EPERM: [-1, "operation not permitted"],
  EACCES: [-13, "permission denied"],
  EINVAL: [-22, "invalid argument"],
  EBUSY: [-16, "resource busy or locked"],
  EIO: [-5, "i/o error"],
  EXDEV: [-18, "cross-device link not permitted"],
  ENOSYS: [-78, "function not implemented"],
  EAGAIN: [-35, "resource temporarily unavailable"],
  EBADF: [-9, "bad file descriptor"],
};

export interface NodeError extends Error {
  code: string;
  errno: number;
  syscall: string;
  path?: string;
  dest?: string;
}

export function fsError(code: string, syscall: string, path?: string, dest?: string, extra?: string): NodeError {
  const [errno, desc] = ERRNO[code] ?? [-1, code.toLowerCase()];
  let message = `${code}: ${extra ?? desc}, ${syscall}`;
  if (path !== undefined) message += ` '${path}'`;
  if (dest !== undefined) message += ` -> '${dest}'`;
  const err = new Error(message) as NodeError;
  err.code = code;
  err.errno = errno;
  err.syscall = syscall;
  if (path !== undefined) err.path = path;
  if (dest !== undefined) err.dest = dest;
  return err;
}

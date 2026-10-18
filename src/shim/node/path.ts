// Node "path" (POSIX flavour; all virtual paths are POSIX).
import pathBrowserify from "path-browserify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const posix: any = { ...(pathBrowserify as object) };
posix.toNamespacedPath = (p: string) => p;
posix.posix = posix;
posix.win32 = posix;
// path-browserify's resolve() falls back to process.cwd(), which we define as "/".
export const path = posix;

// Platform facts reported to Obsidian. We only distinguish macOS from everything else:
// Windows is reported as Linux so that Obsidian keeps using POSIX paths.

const ua = navigator.userAgent;
const isMac = /Mac/.test(navigator.platform || ua) && !/iPhone|iPad/.test(ua);

export const platform = {
  process: (isMac ? "darwin" : "linux") as "darwin" | "linux",
  isMac,
  arch: /arm|aarch64/i.test(ua) || isMac ? "arm64" : "x64",
  osRelease: isMac ? "24.0.0" : "6.8.0",
  osVersion: isMac ? "Darwin Kernel Version 24.0.0" : "#1 SMP",
  homedir: "/home/user",
  /** Electron version we pretend to be (Obsidian gates some features on it). */
  electron: "39.2.0",
  chrome: (/Chrome\/([\d.]+)/.exec(ua)?.[1] ?? "140.0.0.0"),
  node: "22.20.0",
};

export const PATHS = {
  home: platform.homedir,
  userData: platform.homedir + "/.config/obsidian",
  documents: platform.homedir + "/Documents",
  desktop: platform.homedir + "/Desktop",
  downloads: "/downloads",
  temp: "/tmp",
  /** Vaults stored in IndexedDB live here. */
  vaults: "/vaults",
  /** Folders opened through the File System Access API are mounted here. */
  mnt: "/mnt",
  sandbox: platform.homedir + "/.config/obsidian/Obsidian Sandbox",
};

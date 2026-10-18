// Node "os" module.
import { platform } from "../platform";

export const HOME = platform.homedir;

export const os = {
  EOL: "\n",
  platform: () => platform.process,
  type: () => (platform.process === "darwin" ? "Darwin" : "Linux"),
  release: () => platform.osRelease,
  version: () => platform.osVersion,
  arch: () => platform.arch,
  machine: () => (platform.arch === "arm64" ? "arm64" : "x86_64"),
  hostname: () => "browser",
  homedir: () => HOME,
  tmpdir: () => "/tmp",
  endianness: () => "LE",
  uptime: () => Math.floor(performance.now() / 1000),
  loadavg: () => [0, 0, 0],
  totalmem: () => ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) * 1024 ** 3,
  freemem: () => ((navigator as { deviceMemory?: number }).deviceMemory ?? 8) * 1024 ** 3 * 0.5,
  availableParallelism: () => navigator.hardwareConcurrency || 4,
  cpus: () =>
    Array.from({ length: navigator.hardwareConcurrency || 4 }, () => ({
      model: "Browser CPU",
      speed: 2400,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    })),
  networkInterfaces: () => ({}),
  userInfo: () => ({ uid: 501, gid: 20, username: "user", homedir: HOME, shell: "/bin/sh" }),
  constants: { signals: {}, errno: {} },
  devNull: "/dev/null",
};

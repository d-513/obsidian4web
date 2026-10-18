// Launcher: installs the service worker, downloads the official Obsidian release into the
// browser (after the user accepts Obsidian's terms), then opens the app.

import { compareVersions, fetchReleaseInfo, getInstalled, installRelease, type ReleaseInfo } from "../common/installer";

const TERMS =
  "I understand and agree that I am not allowed to distribute the Obsidian application, in any form, without explicit approval from the Obsidian team. I also understand that Obsidian is a registered trademark, and I cannot use it without explicit permission granted by the Obsidian team.";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const manage = params.has("manage");

function nextUrl(): string {
  const next = params.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//")) return next;
  // Direct visit to an app URL without the service worker: Vite/our server served the launcher.
  if (location.pathname !== "/" && location.pathname !== "/index.html") return location.pathname + location.search;
  if (location.pathname === "/index.html" && location.search) return location.pathname + location.search;
  const cfg = readConfig();
  const last = localStorage.getItem("o4w-last-vault");
  if (last && cfg.vaults?.[last]) return `/index.html?vault=${encodeURIComponent(last)}`;
  return "/starter.html";
}

interface Config {
  termsAccepted?: boolean;
  vaults?: Record<string, { path: string }>;
}

function readConfig(): Config {
  try {
    return JSON.parse(localStorage.getItem("o4w-config") || "{}") as Config;
  } catch {
    return {};
  }
}

function writeConfig(fn: (c: Config) => void) {
  const c = readConfig();
  fn(c);
  localStorage.setItem("o4w-config", JSON.stringify(c));
}

function h(html: string): void {
  app.innerHTML = html;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

async function ensureServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers.");
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
  }
  if (!navigator.serviceWorker.controller) {
    // First load after a hard refresh: a normal reload hands the page to the worker.
    location.reload();
    await new Promise(() => {});
  }
}

function go(): void {
  location.replace(nextUrl());
}

function unsupported(): string | null {
  const missing: string[] = [];
  if (!("serviceWorker" in navigator)) missing.push("Service workers");
  if (typeof DecompressionStream === "undefined") missing.push("DecompressionStream");
  if (!("indexedDB" in window)) missing.push("IndexedDB");
  if (!("caches" in window)) missing.push("Cache Storage");
  if (!window.isSecureContext) missing.push("a secure context (HTTPS or localhost)");
  return missing.length ? missing.join(", ") : null;
}

async function main(): Promise<void> {
  const missing = unsupported();
  if (missing) {
    h(`<h1>Browser not supported</h1><p>obsidian4web needs a modern browser. Missing: <strong>${esc(missing)}</strong>.</p>`);
    return;
  }
  await ensureServiceWorker();
  const installed = await getInstalled();
  const cfg = readConfig();
  if (installed && cfg.termsAccepted && !manage) return go();
  render(installed?.version ?? null, !!cfg.termsAccepted);
}

function render(installedVersion: string | null, accepted: boolean): void {
  h(`
    <h1>obsidian4web</h1>
    <p>Runs the <strong>official Obsidian desktop app</strong> in your browser. Obsidian is not bundled
    with this site: your browser downloads it directly from
    <a href="https://github.com/obsidianmd/obsidian-releases/releases" target="_blank" rel="noopener">Obsidian's GitHub releases</a>
    and runs it with a compatibility layer that stands in for Electron and Node.js.</p>
    <p>Your notes stay on this device: in browser storage, or in a folder on your disk (Chromium-based browsers).</p>
    <div class="terms">${esc(TERMS)}</div>
    <p>Obsidian's use is governed by its <a href="https://obsidian.md/license" target="_blank" rel="noopener">license</a> and
    <a href="https://obsidian.md/terms" target="_blank" rel="noopener">terms of service</a>. obsidian4web is not affiliated with Obsidian (Dynalist Inc.).</p>
    <label class="check"><input type="checkbox" id="agree" ${accepted ? "checked" : ""}/> <span>I have read and agree to the statement above.</span></label>
    <div class="row">
      <button class="primary" id="install" ${accepted ? "" : "disabled"}>${installedVersion ? "Open Obsidian" : "Download and open Obsidian"}</button>
      ${installedVersion ? `<button id="update">Check for updates</button>` : ""}
    </div>
    <div class="progress" hidden><div></div></div>
    <div class="status" id="status"></div>
    <div class="error" id="error"></div>
    <div class="meta">
      ${installedVersion ? `Installed: Obsidian ${esc(installedVersion)} · ` : ""}<span id="latest">Checking latest version…</span>
      ${installedVersion ? ` · <a href="#" id="reset">Reset all data…</a>` : ""}
    </div>
  `);
  const agree = app.querySelector<HTMLInputElement>("#agree")!;
  const installBtn = app.querySelector<HTMLButtonElement>("#install")!;
  const statusEl = app.querySelector<HTMLElement>("#status")!;
  const errorEl = app.querySelector<HTMLElement>("#error")!;
  const progress = app.querySelector<HTMLElement>(".progress")!;
  const bar = progress.firstElementChild as HTMLElement;

  agree.addEventListener("change", () => {
    installBtn.disabled = !agree.checked;
    writeConfig((c) => (c.termsAccepted = agree.checked));
  });

  let info: ReleaseInfo | null = null;
  const infoPromise = fetchReleaseInfo().then(
    (i) => {
      info = i;
      app.querySelector("#latest")!.textContent = `Latest: Obsidian ${i.latestVersion}`;
      return i;
    },
    (e) => {
      app.querySelector("#latest")!.textContent = "Could not check the latest version.";
      throw e;
    },
  );

  const install = async (force: boolean) => {
    errorEl.textContent = "";
    installBtn.disabled = true;
    try {
      // Ask the browser not to evict our storage (notes live in IndexedDB).
      await navigator.storage?.persist?.().catch(() => false);
      const rel = info ?? (await infoPromise);
      if (!force && installedVersion && compareVersions(rel.latestVersion, installedVersion) <= 0) return go();
      if (!force && installedVersion) return go();
      progress.hidden = false;
      await installRelease(rel, (phase, loaded, total) => {
        if (phase === "download") {
          const mb = ((loaded ?? 0) / 1048576).toFixed(1);
          statusEl.textContent = total ? `Downloading Obsidian ${rel.latestVersion}… ${mb} / ${(total / 1048576).toFixed(1)} MB` : `Downloading… ${mb} MB`;
          if (total) bar.style.width = `${Math.round(((loaded ?? 0) / total) * 90)}%`;
        } else if (phase === "verify") {
          statusEl.textContent = "Verifying integrity…";
        } else if (phase === "extract") {
          statusEl.textContent = "Unpacking…";
          bar.style.width = "95%";
        } else if (phase === "store") {
          statusEl.textContent = "Saving…";
        } else {
          bar.style.width = "100%";
          statusEl.textContent = "Done.";
        }
      });
      navigator.serviceWorker.controller?.postMessage({ type: "o4w-reload-app" });
      go();
    } catch (e) {
      errorEl.textContent = String((e as Error).message ?? e);
      installBtn.disabled = !agree.checked;
    }
  };

  installBtn.addEventListener("click", () => void install(false));
  app.querySelector("#update")?.addEventListener("click", async () => {
    try {
      const rel = await infoPromise;
      if (installedVersion && compareVersions(rel.latestVersion, installedVersion) <= 0) {
        statusEl.textContent = `Obsidian ${installedVersion} is up to date.`;
        return;
      }
      if (!agree.checked) return;
      void install(true);
    } catch (e) {
      errorEl.textContent = String((e as Error).message ?? e);
    }
  });
  app.querySelector("#reset")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!confirm("Delete ALL vaults stored in this browser, settings and the downloaded app? Folders on your disk are not touched.")) return;
    if (!confirm("This cannot be undone. Really delete everything?")) return;
    for (const name of ["o4w-fs", "o4w-meta"]) indexedDB.deleteDatabase(name);
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
    location.replace("/");
  });
}

main().catch((e) => {
  h(`<h1>Something went wrong</h1><p class="error">${esc(String((e as Error)?.message ?? e))}</p>`);
});

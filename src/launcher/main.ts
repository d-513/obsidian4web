// Launcher: installs the service worker and the official Obsidian release (downloaded through
// the proxy, or from a file the user downloaded themselves), then opens the app.

import {
  canAutoDownload,
  compareVersions,
  fetchReleaseInfo,
  getInstalled,
  inspectRelease,
  installRelease,
  releasesPageUrl,
  storeRelease,
  type InstallPhase,
  type ReleaseInfo,
} from "../common/installer";
import { detectProxy, proxyCaps } from "../common/proxy-client";

const TERMS =
  "I understand and agree that I am not allowed to distribute the Obsidian application, in any form, without explicit approval from the Obsidian team. I also understand that Obsidian is a registered trademark, and I cannot use it without explicit permission granted by the Obsidian team.";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const manage = params.has("manage");

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

function nextUrl(): string {
  const next = params.get("next");
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) {
    try {
      const u = new URL(next, location.origin);
      if (u.origin === location.origin) return u.pathname + u.search + u.hash;
    } catch {
      /* ignore */
    }
  }
  // Direct visit to an app URL without the service worker: the server served the launcher.
  if (location.pathname !== "/" && location.pathname !== "/index.html") return location.pathname + location.search;
  if (location.pathname === "/index.html" && location.search) return location.pathname + location.search;
  const last = localStorage.getItem("o4w-last-vault");
  if (last && readConfig().vaults?.[last]) return `/index.html?vault=${encodeURIComponent(last)}`;
  return "/starter.html";
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mb = (n: number) => (n / 1048576).toFixed(1);

async function ensureServiceWorker(): Promise<void> {
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
  }
  if (!navigator.serviceWorker.controller) {
    // After a hard refresh the page isn't controlled; a normal reload fixes that.
    location.reload();
    await new Promise(() => {});
  }
}

function go(): void {
  location.replace(nextUrl());
}

function unsupported(): string | null {
  const missing: string[] = [];
  if (!window.isSecureContext) missing.push("a secure context (HTTPS)");
  if (!("serviceWorker" in navigator)) missing.push("service workers");
  if (typeof DecompressionStream === "undefined") missing.push("DecompressionStream");
  if (!("indexedDB" in window)) missing.push("IndexedDB");
  if (!("caches" in window)) missing.push("Cache Storage");
  return missing.length ? missing.join(", ") : null;
}

async function main(): Promise<void> {
  const missing = unsupported();
  if (missing) {
    app.innerHTML = `<h1>Browser not supported</h1><p>obsidian4web needs a modern browser. Missing: <strong>${esc(missing)}</strong>.</p>`;
    return;
  }
  await ensureServiceWorker();
  const [installed] = await Promise.all([getInstalled(), detectProxy(true)]);
  if (installed && readConfig().termsAccepted && !manage) return go();
  render(installed?.version ?? null);
}

function render(installedVersion: string | null): void {
  const accepted = !!readConfig().termsAccepted;
  app.innerHTML = `
    <h1>obsidian4web</h1>
    <p>Runs the <strong>official Obsidian desktop app</strong> in your browser. Obsidian is not bundled
    with this site: it comes straight from
    <a href="https://github.com/obsidianmd/obsidian-releases/releases" target="_blank" rel="noopener">Obsidian's GitHub releases</a>
    and runs with a compatibility layer that stands in for Electron and Node.js.</p>
    <p>Your notes stay on this device, in browser storage or in a folder on your disk (Chromium-based browsers).</p>
    <div class="terms">${esc(TERMS)}</div>
    <p>Obsidian's use is governed by its <a href="https://obsidian.md/license" target="_blank" rel="noopener">license</a> and
    <a href="https://obsidian.md/terms" target="_blank" rel="noopener">terms of service</a>. obsidian4web is not affiliated with Obsidian (Dynalist Inc.).</p>
    <label class="check"><input type="checkbox" id="agree" ${accepted ? "checked" : ""}/> <span>I have read and agree to the statement above.</span></label>

    <div id="auto" class="row" hidden>
      <button class="primary" id="install">${installedVersion ? "Update and open" : "Download and open Obsidian"}</button>
      <button class="link" id="show-manual">Install from a file instead</button>
    </div>
    ${installedVersion ? `<div class="row"><button class="primary" id="open">Open Obsidian ${esc(installedVersion)}</button></div>` : ""}

    <section id="manual" class="manual" hidden>
      <h2>Install from a file</h2>
      <ol>
        <li>Download <a id="dl-link" href="${esc(releasesPageUrl())}" target="_blank" rel="noopener"><span id="dl-name">obsidian-x.y.z.asar.gz</span></a>
          from Obsidian's GitHub releases.</li>
        <li>Choose the downloaded file. It is checked against the hash Obsidian publishes.</li>
      </ol>
      <label class="drop" id="drop" tabindex="0">
        <input type="file" id="file" accept=".gz,.asar,application/gzip" hidden />
        <span>Drop <strong id="drop-name">obsidian-x.y.z.asar.gz</strong> here, or click to choose it</span>
      </label>
    </section>

    <div class="progress" hidden><div></div></div>
    <div class="status" id="status"></div>
    <div class="error" id="error"></div>
    <div class="meta">
      <span id="versions">${installedVersion ? `Installed: Obsidian ${esc(installedVersion)} · ` : ""}<span id="latest">Checking latest version…</span></span>
      <span id="proxy"></span>
      ${installedVersion ? `<span>· <a href="#" id="reset">Reset all data…</a></span>` : ""}
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;
  const agree = $<HTMLInputElement>("#agree");
  const statusEl = $("#status");
  const errorEl = $("#error");
  const progress = $(".progress");
  const bar = progress.firstElementChild as HTMLElement;
  const manual = $("#manual");
  const auto = $("#auto");
  let info: ReleaseInfo | null = null;
  let busy = false;

  const caps = proxyCaps();
  $("#proxy").textContent = caps.proxy
    ? ` · Proxy: ${caps.mode}`
    : " · No proxy: plugin installs, Sync and Publish are unavailable";

  const setEnabled = () => {
    for (const b of app.querySelectorAll<HTMLButtonElement>("button.primary")) b.disabled = !agree.checked || busy;
    $("#drop").classList.toggle("disabled", !agree.checked || busy);
  };
  agree.addEventListener("change", () => {
    writeConfig((c) => (c.termsAccepted = agree.checked));
    setEnabled();
  });
  setEnabled();

  const onProgress = (phase: InstallPhase, loaded?: number, total?: number) => {
    progress.hidden = false;
    if (phase === "download") {
      statusEl.textContent = total ? `Downloading… ${mb(loaded ?? 0)} / ${mb(total)} MB` : `Downloading… ${mb(loaded ?? 0)} MB`;
      if (total) bar.style.width = `${Math.round(((loaded ?? 0) / total) * 85)}%`;
    } else if (phase === "verify") {
      statusEl.textContent = "Verifying integrity…";
      bar.style.width = "88%";
    } else if (phase === "extract") {
      statusEl.textContent = "Unpacking…";
      bar.style.width = "93%";
    } else if (phase === "store") {
      statusEl.textContent = "Saving…";
      bar.style.width = "97%";
    } else {
      bar.style.width = "100%";
      statusEl.textContent = "Done.";
    }
  };

  const finish = () => {
    navigator.serviceWorker.controller?.postMessage({ type: "o4w-reload-app" });
    go();
  };

  const run = async (task: () => Promise<void>) => {
    if (busy || !agree.checked) return;
    busy = true;
    setEnabled();
    errorEl.textContent = "";
    try {
      // Ask the browser not to evict our storage (notes live in IndexedDB).
      await navigator.storage?.persist?.().catch(() => false);
      await task();
    } catch (e) {
      errorEl.textContent = String((e as Error).message ?? e);
      progress.hidden = true;
    } finally {
      busy = false;
      setEnabled();
    }
  };

  const showManual = () => {
    manual.hidden = false;
    $("#show-manual").hidden = true;
  };
  $("#show-manual").addEventListener("click", showManual);
  app.querySelector("#open")?.addEventListener("click", () => agree.checked && go());

  $("#install").addEventListener("click", () =>
    run(async () => {
      const rel = info ?? (await fetchReleaseInfo());
      await installRelease(rel, onProgress);
      finish();
    }),
  );

  const installFile = (file: File) =>
    run(async () => {
      statusEl.textContent = `Reading ${file.name}…`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspection = await inspectRelease(bytes, info, onProgress);
      if (inspection.integrity !== "verified") {
        const ok = confirm(
          `This file contains Obsidian ${inspection.version}, but it can't be checked against an official hash` +
            (info ? ` (hashes are only published for the latest version, ${info.latestVersion}, as .asar.gz)` : " (release information is unavailable)") +
            ".\n\nOnly continue if you downloaded it from Obsidian's GitHub releases yourself. Install anyway?",
        );
        if (!ok) {
          progress.hidden = true;
          statusEl.textContent = "";
          return;
        }
      }
      await storeRelease(inspection, onProgress);
      finish();
    });

  const drop = $("#drop");
  const input = $<HTMLInputElement>("#file");
  input.addEventListener("change", () => input.files?.[0] && installFile(input.files[0]));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) installFile(f);
  });
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") input.click();
  });

  void (async () => {
    try {
      info = await fetchReleaseInfo();
      $("#latest").textContent = `Latest: Obsidian ${info.latestVersion}`;
      const a = $<HTMLAnchorElement>("#dl-link");
      a.href = info.downloadUrl;
      $("#dl-name").textContent = $("#drop-name").textContent = info.downloadUrl.split("/").pop()!;
      const upToDate = !!installedVersion && compareVersions(info.latestVersion, installedVersion) <= 0;
      const auto_ = await canAutoDownload(info);
      if (auto_ && !upToDate) auto.hidden = false;
      else if (!upToDate) showManual();
      else statusEl.textContent = `Obsidian ${installedVersion} is up to date.`;
    } catch {
      $("#latest").textContent = "Could not check the latest version.";
      showManual();
    }
  })();

  app.querySelector("#reset")?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    if (!confirm("Delete ALL vaults stored in this browser, settings and the downloaded app? Folders on your disk are not touched.")) return;
    if (!confirm("This cannot be undone. Really delete everything?")) return;
    for (const name of ["o4w-fs", "o4w-meta"]) indexedDB.deleteDatabase(name);
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
    sessionStorage.clear();
    location.replace("/");
  });
}

main().catch((e) => {
  app.innerHTML = `<h1>Something went wrong</h1><p class="error">${esc(String((e as Error)?.message ?? e))}</p>`;
});

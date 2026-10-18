# obsidian4web

Runs the **official Obsidian desktop app** in a modern browser. Nothing from Obsidian is
bundled or redistributed: the user's browser downloads the release (`obsidian-x.y.z.asar.gz`)
straight from Obsidian's GitHub releases after the user accepts Obsidian's terms. The SHA-256
published in `desktop-releases.json` is checked. A compatibility layer then stands in for
Electron and Node.js.

## Running

```sh
pnpm install
pnpm dev                 # http://localhost:5173 (Vite + proxy)

pnpm build && pnpm start # production: static files + proxy on $PORT (default 8080)
```

The site must be served over HTTPS (or `localhost`), because service workers require a secure context.

Proxy options (environment variables for `server/server.js`):

- `O4W_PROXY_ALLOW_HOSTS=".obsidian.md,.github.com,..."`: only allow these destinations.
- `O4W_PROXY_ALLOW_PRIVATE=1`: allow requests to private/loopback addresses (off by default).

## How it works

```
launcher (/)  ── accepts terms, downloads asar via proxy, verifies hash, stores it in Cache Storage
service worker ── serves the asar's files at the origin root (like Electron's app:// protocol),
                  rewrites Obsidian's HTML so /o4w/shim.js runs first,
                  serves vault files under /_vfs/ by asking the page that holds them
shim.js        ── window.require(): fs, path, url, os, crypto, electron, @electron/remote, …
                  process / Buffer / global, emulated main-process IPC (main.js handlers)
server/proxy.js ── CORS proxy for requestUrl/fetch (+ WebSocket proxy for Sync), web viewer pages
```

| Area | Implementation |
| --- | --- |
| Filesystem | `src/shim/vfs`: in-memory tree (so `existsSync`/`statSync`/… work) persisted to IndexedDB, or to a real folder through the File System Access API (Chromium). Changes are synced across tabs and external edits are picked up (FileSystemObserver or polling). |
| Electron | `src/shim/electron`: `ipcRenderer` with all of Obsidian's main-process channels, `remote` (BrowserWindow, webContents, Menu, dialog, shell, clipboard, nativeTheme, safeStorage, …), `webFrame` zoom (CSS zoom). |
| Dialogs | Sync dialogs (`showOpenDialogSync`) use a replay trick: start the async browser picker, then re-run the click that opened the dialog with the result. Save dialogs write to `/downloads`, which become browser downloads. |
| Popout windows | Real browser popups. Their resources are routed through the main window, because `about:blank` popups are not controlled by the service worker. |
| Web viewer | `<webview>` is replaced by a sandboxed iframe that loads pages through the proxy. A bridge script handles navigation, title, favicon, reader mode and `executeJavaScript`. |
| Network | `requestUrl` always goes through the proxy. `fetch` falls back to the proxy on CORS failure (GET). `*.obsidian.md` traffic and WebSockets are always proxied, with `Origin: app://obsidian.md`. |

Storage layout (virtual paths): vaults in browser storage live in `/vaults/<name>`, and local
folders are mounted at `/mnt/<id>/<folder>`. App state lives in `localStorage` (`o4w-config`).

## Security notes

- Proxied responses carry `Content-Security-Policy: sandbox`, so proxied content can never run with this site's origin, where it could read the vaults.
- The proxy and WebSocket proxy reject cross-site use, and refuse private network destinations unless explicitly allowed.
- Web viewer pages run in an opaque-origin sandboxed iframe.

## Known limitations

- Shortcuts the browser reserves (Ctrl/Cmd+N, T, W) can't be captured. Installing the site as an app (PWA) helps.
- Popout windows are not restored on reload, because browsers block popups that aren't triggered by a click.
- Local folders as vaults need a Chromium-based browser. Other browsers use IndexedDB only.
- Export to PDF opens the browser print dialog (choose "Save as PDF").
- Plugins that need native Node modules or `child_process` can't work.
- The Web viewer can't render sites that depend on their own cookies or logins, or on scripts that check their origin.
- Synchronous reads of files that haven't been loaded yet throw `EAGAIN`. The vault's `.obsidian` folder is preloaded for this reason.

Obsidian is a trademark of Dynalist Inc. This project is not affiliated with Obsidian. Use of
Obsidian is subject to its license and terms.

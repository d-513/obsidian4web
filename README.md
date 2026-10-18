# obsidian4web

Runs the **official Obsidian desktop app** in a modern browser. Nothing from Obsidian is
bundled or redistributed: the user's browser downloads the release (`obsidian-x.y.z.asar.gz`)
straight from Obsidian's GitHub releases after the user accepts Obsidian's terms. The SHA-256
published in `desktop-releases.json` is checked. A compatibility layer then stands in for
Electron and Node.js.

## Running locally

```sh
pnpm install
pnpm dev                       # http://localhost:5173 with the proxy (allowlist mode)
O4W_PROXY_MODE=open pnpm dev   # same, with any public host allowed (enables Web viewer pages)
pnpm test                      # proxy hardening tests
```

## Deploying

There are two ways to deploy. Either way the site needs HTTPS (service workers require a
secure context), and any number of hostnames can serve it. Each hostname is a separate
browser origin, so each has its own vaults and settings.

### A. With the proxy (recommended)

The proxy is what allows the one-click app download and update, in-app plugin and theme
installs, Obsidian Sync and Publish, and Web viewer pages.

```sh
pnpm build
O4W_SECRET=$(openssl rand -hex 32) PORT=8080 node server/server.js
# or: docker build -t obsidian4web . && docker run -p 8080:8080 -e O4W_SECRET=... obsidian4web
```

Put it behind a TLS reverse proxy that passes WebSockets. Examples are in `deploy/`
(`Caddyfile`, `nginx.conf`, `docker-compose.yml`). Set `O4W_TRUST_PROXY=1` so that
`X-Forwarded-Host` and `X-Forwarded-For` are honoured.

| Variable | Default | Meaning |
| --- | --- | --- |
| `O4W_SECRET` | random per start | HMAC key for session cookies. Set it in production (and share it between instances). |
| `O4W_PROXY_MODE` | `allowlist` | `allowlist`: Obsidian's services and GitHub only. `open`: any public host. `off`: no proxy. |
| `O4W_PROXY_ALLOW_HOSTS` | | Extra destinations, e.g. `.openai.com,api.anthropic.com` for plugins that call those APIs. `.example.com` matches subdomains. |
| `O4W_PROXY_WEBVIEWER` | on only in `open` | Allow Web viewer pages for any public host (GET, sandboxed). Without it, the Web viewer frames sites directly. |
| `O4W_TRUST_PROXY` | `0` | Trust `X-Forwarded-*` from your reverse proxy. Only enable it behind one. |
| `O4W_ALLOWED_ORIGINS` | | Extra origins allowed to use the proxy, besides each request's own host. |
| `O4W_RATE_LIMIT_RPM` | `300` | Requests per minute, per IP and per session. |
| `O4W_RATE_LIMIT_MB_PER_HOUR` | `2048` | Transfer quota per IP and per session. |
| `O4W_MAX_CONCURRENT` | `24` | Concurrent proxied requests per IP and per session. |
| `O4W_MAX_REQUEST_MB` / `O4W_MAX_RESPONSE_MB` | `64` / `200` | Body size limits. |
| `O4W_TIMEOUT_S` | `120` | Upstream timeout. |
| `O4W_MAX_WEBSOCKETS` | `8` | Open WebSockets (Sync) per IP and per session. |
| `O4W_TOKEN_TTL_HOURS` | `24` | Session cookie lifetime (renewed automatically). |
| `O4W_PROXY_ALLOW_PRIVATE` | `0` | Allow private/loopback destinations (only for trusted, self-hosted setups). |
| `O4W_PROXY_LOG` | `0` | Log proxied requests. |

#### Why it isn't an open relay

- **Only this site's pages can use it.**
  - Requests must come from the same origin: `Origin`, or `Sec-Fetch-Site: same-origin`.
  - They must carry an `X-O4W-Proxy` header. Browsers can't send a custom header cross-site without a CORS preflight, and the proxy never approves one.
  - They need a signed, HttpOnly, `SameSite=Strict` session cookie, which the site only issues to its own pages.
  - WebSocket handshakes must come from an allowed `Origin`.
- **Destinations are restricted.**
  - The allowlist is on by default. Private and loopback addresses are always refused, unless explicitly allowed.
  - The DNS answer is checked when connecting, which stops DNS rebinding.
  - Every redirect hop is checked against the policy again.
- **Abuse is bounded.** Requests, bytes, concurrency and WebSockets are limited per IP and per session, plus size limits and timeouts.
- **Proxied content can't touch the site.** Responses carry `Content-Security-Policy: sandbox` (an opaque origin), so a proxied page can never run with the site's origin. No cookies are passed through in either direction.

Rate limits are kept in memory per process. If you run several instances, also rate-limit
at the load balancer.

### B. Static hosting, no proxy

`dist/` works on any static host (GitHub Pages, Netlify, Cloudflare Pages, S3…).
`404.html` and `_headers` are included. With no proxy, the launcher asks the user to
download `obsidian-x.y.z.asar.gz` from Obsidian's GitHub releases and drop it in. The file
is checked against the SHA-256 hash Obsidian publishes, and its version is read from the
archive. Everything that works offline works: editing, all core plugins, local and on-disk
vaults, popouts, and themes and plugins that are already installed.

Without a proxy:

- **Not available:** one-click install and update (the launcher shows the file flow, and the app shows a notice when an update exists), and in-app plugin and theme installs. GitHub release downloads don't allow cross-origin requests.
- **Not available:** Sync and Publish. Obsidian's API doesn't allow cross-origin requests.
- **Install plugins manually** by copying their files into `.obsidian/plugins/<id>/` of a vault opened from a folder on disk.
- **Web viewer:** frames sites directly, which works for sites that allow being framed. Reader mode is unavailable.
- **Plugin network requests** work only for APIs that send CORS headers.

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
| Network | The client asks `/__proxy/health` what the server offers. `requestUrl` goes through the proxy when the destination is allowed, otherwise direct. `fetch` falls back to the proxy on CORS failure (GET). Obsidian and GitHub traffic, and Sync WebSockets, are proxied with `Origin: app://obsidian.md`. |

Storage layout (virtual paths): vaults in browser storage live in `/vaults/<name>`, and local
folders are mounted at `/mnt/<id>/<folder>`. App state lives in `localStorage` (`o4w-config`).

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

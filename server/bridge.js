// Web viewer bridge: injected into proxied HTML pages, which render in a sandboxed iframe.
// It reports navigation/title/favicon to the embedding <webview> stand-in and runs its
// requests (executeJavaScript for reader mode, zoom, find, CSS injection).

const BRIDGE = `(() => {
  const REAL = __REAL_URL__;
  const post = (m) => parent.postMessage(Object.assign({ o4wWebview: 1 }, m), "*");
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch { return h; } };
  const favicons = () => [...document.querySelectorAll("link[rel~=icon]")].map((l) => abs(l.getAttribute("href")));
  post({ type: "did-start-loading", url: REAL });
  document.addEventListener("DOMContentLoaded", () => {
    post({ type: "dom-ready", url: REAL, title: document.title });
    post({ type: "page-title-updated", title: document.title || REAL });
    const t = document.querySelector("title");
    if (t) new MutationObserver(() => post({ type: "page-title-updated", title: document.title })).observe(t, { childList: true, characterData: true, subtree: true });
  });
  addEventListener("load", () => {
    post({ type: "page-favicon-updated", favicons: favicons() });
    post({ type: "did-finish-load", url: REAL });
    post({ type: "did-stop-loading" });
  });
  addEventListener("hashchange", () => post({ type: "did-navigate-in-page", url: REAL.split("#")[0] + location.hash }));
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    e.preventDefault();
    const url = abs(href);
    const newWin = a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey;
    post({ type: newWin ? "new-window" : "navigate", url });
  }, true);
  document.addEventListener("submit", (e) => {
    const f = e.target;
    if ((f.method || "get").toLowerCase() !== "get") return;
    e.preventDefault();
    const u = new URL(f.action || REAL, document.baseURI);
    u.search = new URLSearchParams(new FormData(f)).toString();
    post({ type: "navigate", url: u.href });
  }, true);
  addEventListener("message", async (e) => {
    const m = e.data || {};
    if (!m.o4wWebviewCmd) return;
    let result = null, error = null;
    try {
      if (m.cmd === "exec") result = await (0, eval)(m.code);
      else if (m.cmd === "zoom") document.documentElement.style.zoom = String(m.factor);
      else if (m.cmd === "find") result = window.find(m.text, !!m.matchCase, !!m.backwards, true);
      else if (m.cmd === "css") { const s = document.createElement("style"); s.textContent = m.css; document.head.appendChild(s); }
      else if (m.cmd === "back") history.back();
      else if (m.cmd === "forward") history.forward();
      try { structuredClone(result); } catch { result = String(result); }
    } catch (err) { error = String(err && err.message || err); }
    e.source.postMessage({ o4wWebviewReply: 1, id: m.id, result, error }, "*");
  });
})();`;

export function injectBridge(html, realUrl) {
  const head =
    `<base href="${realUrl.replace(/"/g, "&quot;")}">` +
    `<script>${BRIDGE.replace("__REAL_URL__", () => JSON.stringify(realUrl).replace(/</g, "\\u003c"))}</script>`;
  // Neutralise <meta http-equiv=Content-Security-Policy> (it would block the bridge) and existing <base>.
  html = html.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, "").replace(/<base\b[^>]*>/gi, "");
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (_m, attrs) => `<head${attrs}>${head}`);
  return head + html;
}

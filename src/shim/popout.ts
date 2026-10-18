// Popout windows are about:blank documents, which browsers don't put under the service
// worker's control. Same-origin resources (Obsidian's CSS/fonts, vault files under /_vfs/)
// are therefore fetched through the main (controlled) window and handed over as blob URLs.

const blobCache = new Map<string, Promise<string>>();

function isOwnUrl(url: string, base: string): URL | null {
  try {
    const u = new URL(url, base);
    return u.origin === location.origin ? u : null;
  } catch {
    return null;
  }
}

function blobUrlFor(url: string): Promise<string> {
  let p = blobCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((b) => URL.createObjectURL(b));
    p.catch(() => blobCache.delete(url));
    blobCache.set(url, p);
  }
  return p;
}

/** Stylesheet text with every same-origin url(...) replaced by a blob URL.
 *  (Inlined as <style>: Obsidian's CSP, inherited by the popout, forbids blob: stylesheets.) */
async function cssWithBlobs(href: string): Promise<string> {
  const key = "css:" + href;
  let p = blobCache.get(key);
  if (!p) {
    p = (async () => {
      let css = await (await fetch(href)).text();
      const refs = new Set<string>();
      css.replace(/url\((['"]?)([^'")]+)\1\)/g, (_m, _q, ref: string) => {
        if (!ref.startsWith("data:") && !ref.startsWith("#")) refs.add(ref);
        return "";
      });
      const map = new Map<string, string>();
      await Promise.all(
        [...refs].map(async (ref) => {
          const abs = isOwnUrl(ref, href);
          if (abs) map.set(ref, await blobUrlFor(abs.href).catch(() => abs.href));
        }),
      );
      css = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (m, q, ref: string) => (map.has(ref) ? `url(${q}${map.get(ref)}${q})` : m));
      return css;
    })();
    p.catch(() => blobCache.delete(key));
    blobCache.set(key, p);
  }
  return p;
}

const SRC_TAGS = new Set(["IMG", "VIDEO", "AUDIO", "SOURCE", "EMBED", "IFRAME", "TRACK", "INPUT"]);

export function setupPopout(win: Window): void {
  const w = win as Window & typeof globalThis;
  // Requests made by code running against the popout go through the controlled window.
  w.fetch = ((input: RequestInfo | URL, init?: RequestInit) => window.fetch(input, init)) as typeof fetch;

  const fix = (el: Element) => {
    const base = w.document.baseURI;
    if (el.tagName === "LINK") {
      const link = el as HTMLLinkElement;
      const href = link.getAttribute("href");
      if (!href || href.startsWith("blob:") || !/stylesheet|icon/i.test(link.rel)) return;
      const abs = isOwnUrl(href, base);
      if (!abs) return;
      if (/stylesheet/i.test(link.rel)) {
        if (link.dataset.o4wInlined) return;
        link.dataset.o4wInlined = "1";
        void cssWithBlobs(abs.href).then((css) => {
          const style = w.document.createElement("style");
          style.dataset.o4wFrom = abs.href;
          style.textContent = css;
          link.after(style);
          link.media = "not all";
        }, () => {});
      } else {
        void blobUrlFor(abs.href).then((b) => link.setAttribute("href", b), () => {});
      }
    } else if (SRC_TAGS.has(el.tagName)) {
      const src = el.getAttribute("src");
      if (!src || src.startsWith("blob:") || src.startsWith("data:")) return;
      const abs = isOwnUrl(src, base);
      if (!abs) return;
      void blobUrlFor(abs.href).then((b) => {
        if (el.getAttribute("src") === src) el.setAttribute("src", b);
      }, () => {});
    }
  };

  const scan = (root: Node) => {
    if (root instanceof w.Element || root instanceof Element) {
      fix(root as Element);
      (root as Element).querySelectorAll("link, img, video, audio, source, embed, iframe, track").forEach(fix);
    }
  };

  const observer = new w.MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes") fix(r.target as Element);
      else r.addedNodes.forEach(scan);
    }
  });
  observer.observe(w.document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
  w.addEventListener("unload", () => observer.disconnect());
}

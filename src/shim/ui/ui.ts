// Small DOM UI toolkit styled with Obsidian's own CSS classes (modals, menus, notices).

export interface ModalButton {
  text: string;
  cta?: boolean;
  warning?: boolean;
  value: number;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface ModalOptions {
  title?: string;
  message?: string;
  detail?: string;
  buttons: ModalButton[];
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  cancelValue?: number;
  /** Extra content builder. */
  content?: (container: HTMLElement, close: (value: number) => void) => void;
  doc?: Document;
}

export function showModal(opts: ModalOptions): Promise<{ response: number; checkboxChecked: boolean }> {
  const doc = opts.doc ?? activeDoc();
  return new Promise((resolve) => {
    const container = el(doc, "div", "modal-container mod-dim o4w-modal");
    const bg = el(doc, "div", "modal-bg");
    bg.style.opacity = "0.85";
    const modal = el(doc, "div", "modal");
    const closeBtn = el(doc, "div", "modal-close-button");
    const titleEl = el(doc, "div", "modal-title", opts.title ?? "");
    const contentEl = el(doc, "div", "modal-content");
    let checkbox: HTMLInputElement | null = null;
    const finish = (value: number) => {
      container.remove();
      doc.removeEventListener("keydown", onKey, true);
      resolve({ response: value, checkboxChecked: checkbox?.checked ?? false });
    };
    const cancel = opts.cancelValue ?? opts.buttons[opts.buttons.length - 1]?.value ?? -1;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(cancel);
      }
    };
    if (opts.message) contentEl.appendChild(el(doc, "p", "", opts.message)).style.whiteSpace = "pre-wrap";
    if (opts.detail) {
      const p = el(doc, "p", "mod-muted", opts.detail);
      p.style.whiteSpace = "pre-wrap";
      p.style.color = "var(--text-muted)";
      contentEl.appendChild(p);
    }
    opts.content?.(contentEl, finish);
    if (opts.checkboxLabel) {
      const label = el(doc, "label", "o4w-checkbox");
      checkbox = el(doc, "input");
      checkbox.type = "checkbox";
      checkbox.checked = !!opts.checkboxChecked;
      label.append(checkbox, " " + opts.checkboxLabel);
      contentEl.appendChild(label);
    }
    const buttons = el(doc, "div", "modal-button-container");
    for (const b of opts.buttons) {
      const btn = el(doc, "button", b.cta ? "mod-cta" : b.warning ? "mod-warning" : "", b.text);
      btn.addEventListener("click", () => finish(b.value));
      buttons.appendChild(btn);
    }
    closeBtn.addEventListener("click", () => finish(cancel));
    bg.addEventListener("click", () => finish(cancel));
    modal.append(closeBtn, titleEl, contentEl);
    if (opts.buttons.length) modal.appendChild(buttons);
    container.append(bg, modal);
    doc.body.appendChild(container);
    doc.addEventListener("keydown", onKey, true);
    (buttons.querySelector("button.mod-cta") as HTMLButtonElement | null)?.focus();
  });
}

export function notice(message: string, timeout = 5000, doc: Document = activeDoc()): void {
  let container = doc.body.querySelector(".notice-container") as HTMLElement | null;
  if (!container) {
    container = el(doc, "div", "notice-container");
    doc.body.appendChild(container);
  }
  const n = el(doc, "div", "notice", message);
  n.addEventListener("click", () => n.remove());
  container.appendChild(n);
  setTimeout(() => n.remove(), timeout);
}

export function activeDoc(): Document {
  const w = (globalThis as { activeWindow?: Window }).activeWindow;
  return w?.document ?? document;
}

// ---------------------------------------------------------------------------
// Menus (for Electron's Menu.popup)

export interface MenuTemplateItem {
  label?: string;
  type?: "normal" | "separator" | "submenu" | "checkbox" | "radio";
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  accelerator?: string;
  role?: string;
  id?: string;
  submenu?: MenuTemplateItem[] | { items: MenuTemplateItem[] };
  click?: (item: MenuTemplateItem, win: unknown, event: unknown) => void;
}

const ROLE_LABELS: Record<string, string> = {
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteandmatchstyle: "Paste and Match Style",
  selectall: "Select All",
  delete: "Delete",
  reload: "Reload",
  forcereload: "Force Reload",
  toggledevtools: "Toggle Developer Tools",
  togglefullscreen: "Toggle Full Screen",
  resetzoom: "Actual Size",
  zoomin: "Zoom In",
  zoomout: "Zoom Out",
  minimize: "Minimize",
  close: "Close",
  quit: "Quit",
};

export function performRole(role: string, doc: Document): void {
  switch (role.toLowerCase()) {
    case "undo":
    case "redo":
    case "cut":
    case "copy":
    case "delete":
      doc.execCommand(role.toLowerCase());
      break;
    case "paste":
    case "pasteandmatchstyle":
      void navigator.clipboard.readText().then((t) => doc.execCommand("insertText", false, t));
      break;
    case "selectall":
      doc.execCommand("selectAll");
      break;
    case "reload":
    case "forcereload":
      doc.defaultView?.location.reload();
      break;
    case "togglefullscreen":
      if (doc.fullscreenElement) void doc.exitFullscreen();
      else void doc.documentElement.requestFullscreen();
      break;
    case "close":
      doc.defaultView?.close();
      break;
  }
}

let openMenu: { el: HTMLElement; close: () => void } | null = null;

function itemsOf(sub: MenuTemplateItem["submenu"]): MenuTemplateItem[] {
  if (!sub) return [];
  return Array.isArray(sub) ? sub : sub.items;
}

export function popupMenu(items: MenuTemplateItem[], x: number, y: number, doc: Document, onClose: () => void): void {
  openMenu?.close();
  const win = doc.defaultView!;
  const menus: HTMLElement[] = [];
  const close = () => {
    for (const m of menus) m.remove();
    doc.removeEventListener("mousedown", onDown, true);
    doc.removeEventListener("keydown", onKey, true);
    if (openMenu?.el === root) openMenu = null;
    onClose();
  };
  const onDown = (e: MouseEvent) => {
    if (!menus.some((m) => m.contains(e.target as Node))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  const build = (list: MenuTemplateItem[], left: number, top: number, depth: number): HTMLElement => {
    const menu = el(doc, "div", "menu o4w-menu");
    menu.style.position = "fixed";
    menu.style.zIndex = String(1000 + depth);
    const scroll = el(doc, "div", "menu-scroll");
    menu.appendChild(scroll);
    let group = el(doc, "div", "menu-group");
    scroll.appendChild(group);
    let lastWasSep = true;
    for (const item of list) {
      if (item.visible === false) continue;
      if (item.type !== "separator" && !item.label && !item.role) continue;
      if (item.type === "separator") {
        if (lastWasSep) continue;
        lastWasSep = true;
        scroll.appendChild(el(doc, "div", "menu-separator"));
        group = el(doc, "div", "menu-group");
        scroll.appendChild(group);
        continue;
      }
      lastWasSep = false;
      const row = el(doc, "div", "menu-item tappable");
      const enabled = item.enabled !== false;
      if (!enabled) row.classList.add("is-disabled");
      const icon = el(doc, "div", "menu-item-icon");
      if (item.checked) icon.textContent = "✓";
      row.appendChild(icon);
      const label = (item.label ?? (item.role ? ROLE_LABELS[item.role.toLowerCase()] ?? item.role : "")).replace(/&&/g, "&");
      row.appendChild(el(doc, "div", "menu-item-title", label));
      const sub = itemsOf(item.submenu);
      if (sub.length) {
        row.classList.add("has-submenu");
        row.appendChild(el(doc, "div", "menu-item-icon mod-submenu", "›"));
        let child: HTMLElement | null = null;
        row.addEventListener("mouseenter", () => {
          for (const m of menus.slice(depth + 1)) m.remove();
          menus.length = depth + 1;
          const r = row.getBoundingClientRect();
          child = build(sub, r.right - 2, r.top - 6, depth + 1);
        });
      } else {
        row.addEventListener("mouseenter", () => {
          for (const m of menus.slice(depth + 1)) m.remove();
          menus.length = depth + 1;
        });
      }
      row.addEventListener("click", (e) => {
        if (!enabled || sub.length) return;
        e.preventDefault();
        close();
        if (item.click) item.click(item, null, { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
        else if (item.role) performRole(item.role, doc);
      });
      group.appendChild(row);
    }
    doc.body.appendChild(menu);
    menus[depth] = menu;
    const rect = menu.getBoundingClientRect();
    if (left + rect.width > win.innerWidth) left = Math.max(0, win.innerWidth - rect.width - 4);
    if (top + rect.height > win.innerHeight) top = Math.max(0, win.innerHeight - rect.height - 4);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    return menu;
  };
  const root = build(items, x, y, 0);
  openMenu = { el: root, close };
  setTimeout(() => {
    doc.addEventListener("mousedown", onDown, true);
    doc.addEventListener("keydown", onKey, true);
  }, 0);
}

// Electron's dialog module on top of browser pickers.
//
// Electron's *Sync dialogs block; browsers can't. We use a "replay" trick: the sync call
// starts the async picker and returns "cancelled". When the user picks something we stash
// the result and re-dispatch the click that triggered the dialog, so the same handler runs
// again and this time the sync call returns the stashed result immediately.

import { vfs } from "../vfs/vfs";
import { PATHS } from "../platform";
import { addFolder, folderMountPath, supportsFsa } from "../state";
import { FsaBackend } from "../vfs/fsa";
import { showModal, activeDoc, notice } from "./ui";

interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: { name: string; extensions: string[] }[];
  properties?: string[];
  message?: string;
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

// ---------------------------------------------------------------------------
// Replay machinery

let lastTrigger: { target: EventTarget; time: number } | null = null;
let replayResult: string[] | null = null;
let replaying = false;

export function trackActivation(win: Window): void {
  const record = (e: Event) => {
    if (!replaying && e.isTrusted) lastTrigger = { target: e.target!, time: Date.now() };
  };
  win.document.addEventListener("click", record, true);
  win.document.addEventListener("keydown", record, true);
}

function replay(result: string[]): void {
  const trigger = lastTrigger;
  if (!trigger || !(trigger.target instanceof Element) || !trigger.target.isConnected) {
    console.warn("[o4w] dialog result could not be delivered (trigger element is gone)", result);
    return;
  }
  replayResult = result;
  replaying = true;
  try {
    (trigger.target as HTMLElement).click();
  } finally {
    replaying = false;
    replayResult = null;
  }
}

/** Synchronous dialog: returns a pending replay result, or starts the async flow. */
function syncDialog(run: () => Promise<string[] | null>): string[] | undefined {
  if (replayResult) {
    const r = replayResult;
    replayResult = null;
    return r;
  }
  const trigger = lastTrigger;
  void run().then(
    (paths) => {
      if (!paths || !paths.length) return;
      lastTrigger = trigger;
      replay(paths);
    },
    (e) => {
      if ((e as DOMException)?.name !== "AbortError") {
        console.error(e);
        notice(String((e as Error)?.message ?? e));
      }
    },
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Pickers

/** Ask the user for a folder on disk and mount it; returns its virtual path. */
export async function pickLocalFolder(): Promise<string | null> {
  if (!supportsFsa) {
    await showModal({
      title: "Local folders are not supported",
      message:
        "This browser does not support the File System Access API. Use a Chromium-based browser (Chrome, Edge, Brave, Arc…) to open folders from your disk, or store the vault in browser storage.",
      buttons: [{ text: "OK", cta: true, value: 0 }],
    });
    return null;
  }
  const handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({
    mode: "readwrite",
    id: "o4w-vault",
  });
  if (!(await FsaBackend.ensurePermission(handle, true))) return null;
  const rec = await addFolder(handle);
  const path = folderMountPath(rec);
  if (!vfs.getMounts().some((m) => m.path === path)) {
    await vfs.mount(path, new FsaBackend(handle));
  }
  return path;
}

type DirPurpose = "open-vault" | "location";

function directoryPurpose(opts: OpenDialogOptions): DirPurpose {
  const t = (key: string) => {
    try {
      return (window as unknown as { i18next?: { t(k: string): string } }).i18next?.t(key);
    } catch {
      return undefined;
    }
  };
  if (opts.title && opts.title === t("interface.startScreen.optionOpenFolderAsVault")) return "open-vault";
  return "location";
}

async function chooseDirectory(opts: OpenDialogOptions): Promise<string[] | null> {
  const purpose = directoryPurpose(opts);
  if (purpose === "open-vault") {
    const p = await pickLocalFolder();
    return p ? [p] : null;
  }
  const { response } = await showModal({
    title: opts.title || "Choose a location",
    message: "Where should this be stored?",
    detail: supportsFsa
      ? "Browser storage keeps notes inside this browser (IndexedDB). A folder on disk keeps them as regular files you can access from other apps."
      : "Notes will be stored inside this browser (IndexedDB). Opening folders from disk requires a Chromium-based browser.",
    buttons: [
      { text: "Browser storage", cta: true, value: 0 },
      ...(supportsFsa ? [{ text: "Folder on disk…", value: 1 }] : []),
      { text: "Cancel", value: 2 },
    ],
    cancelValue: 2,
  });
  if (response === 0) {
    if (!vfs.exists(PATHS.vaults)) vfs.mkdir(PATHS.vaults, true);
    return [PATHS.vaults];
  }
  if (response === 1) {
    const p = await pickLocalFolder();
    return p ? [p] : null;
  }
  return null;
}

function acceptFor(filters?: { extensions: string[] }[]): string {
  const exts = (filters ?? []).flatMap((f) => f.extensions).filter((e) => e && e !== "*");
  return exts.map((e) => "." + e).join(",");
}

/** Copy picked File objects into the VFS so Obsidian can read them by path. */
async function importFiles(files: File[]): Promise<string[]> {
  const dir = `${PATHS.temp}/picked/${Date.now().toString(36)}`;
  vfs.mkdir(dir, true);
  const out: string[] = [];
  for (const f of files) {
    const path = `${dir}/${f.name}`;
    await vfs.write(path, new Uint8Array(await f.arrayBuffer()), { mtime: f.lastModified });
    out.push(path);
  }
  return out;
}

function pickFiles(opts: OpenDialogOptions): Promise<string[] | null> {
  return new Promise((resolve) => {
    const doc = activeDoc();
    const input = doc.createElement("input");
    input.type = "file";
    input.accept = acceptFor(opts.filters);
    input.multiple = !!opts.properties?.includes("multiSelections");
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      input.remove();
      if (!files.length) return resolve(null);
      importFiles(files).then(resolve, () => resolve(null));
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    doc.body.appendChild(input);
    input.click();
  });
}

function runOpenDialog(opts: OpenDialogOptions): Promise<string[] | null> {
  if (opts.properties?.includes("openDirectory")) return chooseDirectory(opts);
  return pickFiles(opts);
}

// ---------------------------------------------------------------------------
// Electron API

export const dialog = {
  showOpenDialogSync(_win?: unknown, opts?: OpenDialogOptions): string[] | undefined {
    if (!opts && _win && typeof _win === "object" && !("webContents" in (_win as object))) opts = _win as OpenDialogOptions;
    return syncDialog(() => runOpenDialog(opts ?? {}));
  },
  async showOpenDialog(_win?: unknown, opts?: OpenDialogOptions) {
    if (!opts) opts = _win as OpenDialogOptions;
    const paths = await runOpenDialog(opts ?? {});
    return { canceled: !paths?.length, filePaths: paths ?? [] };
  },
  showSaveDialogSync(_win?: unknown, opts?: SaveDialogOptions): string | undefined {
    if (!opts) opts = _win as SaveDialogOptions;
    return saveTarget(opts);
  },
  async showSaveDialog(_win?: unknown, opts?: SaveDialogOptions) {
    if (!opts) opts = _win as SaveDialogOptions;
    const filePath = saveTarget(opts);
    return { canceled: !filePath, filePath };
  },
  async showMessageBox(_win?: unknown, opts?: MessageBoxOptions) {
    if (!opts) opts = _win as MessageBoxOptions;
    return messageBox(opts);
  },
  showMessageBoxSync(_win?: unknown, opts?: MessageBoxOptions): number {
    if (!opts) opts = _win as MessageBoxOptions;
    const buttons = opts.buttons ?? ["OK"];
    const text = [opts.message, opts.detail].filter(Boolean).join("\n\n");
    if (buttons.length <= 1) {
      alert(text);
      return 0;
    }
    const ok = confirm(text);
    const cancelId = opts.cancelId ?? buttons.length - 1;
    return ok ? (cancelId === 0 ? 1 : 0) : cancelId;
  },
  showErrorBox(title: string, content: string) {
    alert(title + "\n\n" + content);
  },
  showCertificateTrustDialog: async () => {},
};

interface MessageBoxOptions {
  message: string;
  detail?: string;
  title?: string;
  type?: string;
  buttons?: string[];
  defaultId?: number;
  cancelId?: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

export async function messageBox(opts: MessageBoxOptions): Promise<{ response: number; checkboxChecked: boolean }> {
  const buttons = opts.buttons?.length ? opts.buttons : ["OK"];
  const defaultId = opts.defaultId ?? 0;
  return showModal({
    title: opts.title,
    message: opts.message,
    detail: opts.detail,
    buttons: buttons.map((text, i) => ({ text, value: i, cta: i === defaultId })),
    cancelValue: opts.cancelId ?? buttons.length - 1,
    checkboxLabel: opts.checkboxLabel,
    checkboxChecked: opts.checkboxChecked,
  });
}

/** Save dialogs target the virtual downloads folder; writes there become browser downloads. */
function saveTarget(opts: SaveDialogOptions): string {
  let name = (opts.defaultPath ?? "").split("/").pop() || "Untitled";
  const ext = opts.filters?.[0]?.extensions?.[0];
  if (ext && ext !== "*" && !name.toLowerCase().endsWith("." + ext.toLowerCase())) name += "." + ext;
  return `${PATHS.downloads}/${name}`;
}

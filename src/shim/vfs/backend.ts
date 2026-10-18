// Persistence backends for the in-memory VFS.
// All paths given to a backend are relative to its mount point, "" being the root,
// using "/" separators and no leading slash.

export interface Meta {
  mtime: number;
  ctime: number;
  birthtime: number;
  mode?: number;
}

export interface ScanEntry extends Meta {
  path: string;
  type: "file" | "dir";
  size: number;
  /** Optional eagerly-loaded content. */
  data?: Uint8Array;
}

export type ExternalChange =
  | { kind: "upsert"; entry: ScanEntry }
  | { kind: "delete"; path: string };

export interface Backend {
  readonly kind: string;
  /** Whether the backend persists data at all (memory mounts do not). */
  readonly persistent: boolean;
  scan(): Promise<ScanEntry[]>;
  read(path: string): Promise<Uint8Array>;
  /** Read a byte range directly from storage (optional; used for large media). */
  readRange?(path: string, start: number, end: number): Promise<Uint8Array>;
  write(path: string, data: Uint8Array, meta: Meta): Promise<void>;
  mkdir(path: string, meta: Meta): Promise<void>;
  /** Remove a file, or an (already emptied) directory. */
  remove(path: string, type: "file" | "dir"): Promise<void>;
  /** Move a file or a whole directory subtree. */
  rename(from: string, to: string, type: "file" | "dir"): Promise<void>;
  setMeta(path: string, meta: Meta, type: "file" | "dir"): Promise<void>;
  /** Subscribe to changes made outside of this tab (other tabs, other apps). */
  watchExternal?(cb: (changes: ExternalChange[]) => void): () => void;
  /** Re-scan for external changes (e.g. on window focus). */
  poll?(): Promise<void>;
}

/** A backend that keeps nothing: content lives only in the VFS memory tree. */
export class MemoryBackend implements Backend {
  readonly kind = "memory";
  readonly persistent = false;
  async scan(): Promise<ScanEntry[]> {
    return [];
  }
  async read(): Promise<Uint8Array> {
    throw new Error("memory backend has no storage");
  }
  async write(): Promise<void> {}
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
  async setMeta(): Promise<void> {}
}

// "Downloads" mount: anything written here is handed to the browser as a file download.
import type { Backend, Meta, ScanEntry } from "./backend";
import { mimeFor } from "../../common/config";

export class DownloadsBackend implements Backend {
  readonly kind = "downloads";
  readonly persistent = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  async scan(): Promise<ScanEntry[]> {
    return [];
  }
  async read(): Promise<Uint8Array> {
    return new Uint8Array(0);
  }
  async write(path: string, data: Uint8Array, _meta: Meta): Promise<void> {
    // Debounce: some writers write a file in several steps.
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        const name = path.split("/").pop() || "download";
        const blob = new Blob([data as BlobPart], { type: mimeFor(name) });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }, 400),
    );
  }
  async mkdir(): Promise<void> {}
  async remove(): Promise<void> {}
  async rename(): Promise<void> {}
  async setMeta(): Promise<void> {}
}

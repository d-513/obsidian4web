// Minimal reader for Electron's asar archive format.
// Layout: [u32 4][u32 headerPickleSize][u32 payloadSize][u32 jsonLength][json...][file data...]

export interface AsarFileEntry {
  offset: number; // absolute offset in the archive
  size: number;
}

export interface AsarIndex {
  files: Map<string, AsarFileEntry>; // "lib/moment.min.js" -> entry
  dirs: Set<string>;
}

interface RawNode {
  files?: Record<string, RawNode>;
  offset?: string;
  size?: number;
  unpacked?: boolean;
  link?: string;
}

export function parseAsarHeader(head: Uint8Array): { json: string; dataOffset: number } {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const headerPickleSize = view.getUint32(4, true);
  const jsonLength = view.getUint32(12, true);
  if (head.byteLength < 16 + jsonLength) throw new Error("asar header truncated");
  const json = new TextDecoder().decode(head.subarray(16, 16 + jsonLength));
  return { json, dataOffset: 8 + headerPickleSize };
}

export function headerSize(head: Uint8Array): number {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  return 8 + view.getUint32(4, true);
}

export function buildIndex(json: string, dataOffset: number): AsarIndex {
  const root = JSON.parse(json) as RawNode;
  const files = new Map<string, AsarFileEntry>();
  const dirs = new Set<string>([""]);
  const walk = (node: RawNode, prefix: string) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const p = prefix ? prefix + "/" + name : name;
      if (child.files) {
        dirs.add(p);
        walk(child, p);
      } else if (child.offset !== undefined && !child.unpacked) {
        files.set(p, { offset: dataOffset + Number(child.offset), size: child.size ?? 0 });
      }
    }
  };
  walk(root, "");
  return { files, dirs };
}

export async function indexFromBlob(blob: Blob): Promise<AsarIndex> {
  const first = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const size = headerSize(first);
  const head = new Uint8Array(await blob.slice(0, size).arrayBuffer());
  const { json, dataOffset } = parseAsarHeader(head);
  return buildIndex(json, dataOffset);
}

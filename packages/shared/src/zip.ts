/**
 * A minimal, dependency-free ZIP reader.
 *
 * A .3mf is an OPC package, i.e. a plain ZIP. We only ever need a handful of
 * small text entries out of a file that is mostly mesh data and PNGs, so
 * reading the central directory and inflating individual entries on demand
 * is both simpler and cheaper than pulling in a full zip library.
 *
 * Inflate is done with `DecompressionStream("deflate-raw")`, which exists in
 * workerd and in every browser we care about - so this module runs unchanged
 * on the server (upload handler) and in the client (future drag-to-preview
 * without a round trip).
 *
 * Not supported, on purpose: encryption, and ZIP64 archives whose entry
 * count or offsets exceed the 32-bit fields. Bambu Studio does not produce
 * either. Anything else throws, and the upload route turns that into a 400.
 */

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header within the archive */
  localHeaderOffset: number;
  crc32: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  readonly #bytes: Uint8Array;

  private constructor(bytes: Uint8Array, entries: Map<string, ZipEntry>) {
    this.#bytes = bytes;
    this.entries = entries;
  }

  static open(bytes: Uint8Array): ZipArchive {
    return new ZipArchive(bytes, readCentralDirectory(bytes));
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Entry names matching a predicate, in central-directory order. */
  find(predicate: (name: string) => boolean): string[] {
    return [...this.entries.keys()].filter(predicate);
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return inflateEntry(this.#bytes, entry);
  }

  async readText(name: string): Promise<string | undefined> {
    const bytes = await this.read(name);
    if (!bytes) return undefined;
    // Bambu writes UTF-8 throughout; the BOM shows up on some Windows exports.
    return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  }
}

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits at the tail, after a comment of
  // up to 64KiB, so scan backwards for its signature.
  const minEocd = 22;
  if (bytes.byteLength < minEocd) throw new Error("Not a zip file (too short)");
  const scanFloor = Math.max(0, bytes.byteLength - minEocd - 0xffff);
  let eocd = -1;
  for (let i = bytes.byteLength - minEocd; i >= scanFloor; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end-of-central-directory record)");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (centralOffset === 0xffffffff || entryCount === 0xffff) {
    throw new Error("ZIP64 archives are not supported");
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw new Error("Corrupt zip (central directory runs past end of file)");
  }

  const entries = new Map<string, ZipEntry>();
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error("Corrupt zip (bad central directory header)");
    }
    const flags = view.getUint16(cursor + 8, true);
    if (flags & 0x1) throw new Error("Encrypted zip entries are not supported");

    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    // Bit 11 means the name is UTF-8; older writers use CP437, but every
    // path we care about inside a .3mf is ASCII either way.
    const name = new TextDecoder("utf-8").decode(nameBytes);

    entries.set(name, {
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      crc32,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

async function inflateEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (view.getUint32(header, true) !== LOCAL_SIGNATURE) {
    throw new Error(`Corrupt zip (bad local header for ${entry.name})`);
  }
  // The local header repeats the name/extra lengths, and they can differ from
  // the central directory's - the data always starts after the local copies.
  const nameLength = view.getUint16(header + 26, true);
  const extraLength = view.getUint16(header + 28, true);
  const dataStart = header + 30 + nameLength + extraLength;
  const data = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return data.slice();
  if (entry.method !== 8) {
    throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
  }

  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.uncompressedSize && inflated.byteLength !== entry.uncompressedSize) {
    throw new Error(`Corrupt zip (size mismatch for ${entry.name})`);
  }
  return inflated;
}

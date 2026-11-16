import { inflateRawSync } from "node:zlib";

/**
 * A minimal, read-only zip reader for workflow artifacts.
 *
 * Artifacts are untrusted input, so this reads only what it is asked for and
 * refuses anything unusual rather than trying to cope with it: zip64 archives
 * are rejected outright; entries that are encrypted, use a compression method
 * other than store or deflate, name a path outside the archive, or exceed the
 * size cap are skipped. Nothing is ever written to disk.
 */

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export interface UnzipOptions {
  /** Largest entry, uncompressed, that will be read. Default 1 MiB. */
  maxEntryBytes?: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Returns the entries whose names satisfy `wanted`. Throws on a malformed or zip64 archive. */
export function unzipMatching(zip: Buffer, wanted: (name: string) => boolean, options: UnzipOptions = {}): ZipEntry[] {
  const maxEntryBytes = options.maxEntryBytes ?? 1024 * 1024;
  const eocd = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(eocd + 10);
  const centralSize = zip.readUInt32LE(eocd + 12);
  const centralOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (centralOffset + centralSize > zip.length) throw new Error("central directory lies outside the archive");

  const out: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error("malformed central directory");
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!isSafeEntryName(name) || !wanted(name)) continue;
    if (flags & 0x1) continue; // encrypted
    if (method !== 0 && method !== 8) continue;
    if (uncompressedSize > maxEntryBytes || compressedSize > maxEntryBytes) continue;

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`malformed local header for ${name}`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > zip.length) throw new Error(`entry ${name} runs past the end of the archive`);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: maxEntryBytes });
    } catch {
      continue;
    }
    out.push({ name, data });
  }
  return out;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record is 22 bytes plus a comment of at most 65535 bytes.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= floor; i -= 1) {
    if (zip.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("not a zip archive");
}

function isSafeEntryName(name: string): boolean {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return !name.split("/").includes("..");
}

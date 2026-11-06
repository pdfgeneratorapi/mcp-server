/**
 * Reads the files out of a zip archive, which is how the API answers with more than one page
 * image. Node's zlib inflates them, so no package is needed. The sizes come from the central
 * directory, because an entry written as a stream carries none in its local header. Zip64 and
 * encrypted archives are refused: the API sends neither.
 */
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

export class ZipError extends Error {}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const LOCAL_FILE_HEADER_SIZE = 30;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_COUNT = 0xffff;
const ZIP64_SIZE = 0xffffffff;
const ENCRYPTED = 0x1;
const STORED = 0;
const DEFLATED = 8;

/** The files of the archive in the order it lists them, directories left out. */
export function readZip(archive: Buffer): ZipEntry[] {
  try {
    return readEntries(archive);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_OUT_OF_RANGE') {
      throw new ZipError('The zip archive is truncated.');
    }
    throw error;
  }
}

function readEntries(archive: Buffer): ZipEntry[] {
  const end = findEndOfCentralDirectory(archive);
  const count = archive.readUInt16LE(end + 10);
  const directoryOffset = archive.readUInt32LE(end + 16);

  if (count === ZIP64_COUNT || directoryOffset === ZIP64_SIZE) {
    throw new ZipError('Zip64 archives are not supported.');
  }

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;

  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_HEADER) {
      throw new ZipError('The zip central directory is corrupt.');
    }

    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_DIRECTORY_HEADER_SIZE;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    offset = nameStart + nameLength + extraLength + commentLength;

    if (flags & ENCRYPTED) {
      throw new ZipError(`The zip entry "${name}" is encrypted.`);
    }
    if (compressedSize === ZIP64_SIZE || size === ZIP64_SIZE || localHeaderOffset === ZIP64_SIZE) {
      throw new ZipError('Zip64 archives are not supported.');
    }
    if (name.endsWith('/')) {
      continue;
    }

    const data = inflate(name, method, compressedData(archive, localHeaderOffset, compressedSize), size);
    if (data.length !== size || crc32(data) !== crc) {
      throw new ZipError(`The zip entry "${name}" is corrupt.`);
    }

    entries.push({ name, data });
  }

  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.length < END_OF_CENTRAL_DIRECTORY_SIZE) {
    throw new ZipError('The data is not a zip archive.');
  }

  const earliest = Math.max(0, archive.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_LENGTH);

  for (let offset = archive.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= earliest; offset--) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }

  throw new ZipError('The data is not a zip archive.');
}

function compressedData(archive: Buffer, localHeaderOffset: number, compressedSize: number): Buffer {
  if (archive.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER) {
    throw new ZipError('The zip archive is corrupt.');
  }

  const nameLength = archive.readUInt16LE(localHeaderOffset + 26);
  const extraLength = archive.readUInt16LE(localHeaderOffset + 28);
  const start = localHeaderOffset + LOCAL_FILE_HEADER_SIZE + nameLength + extraLength;

  if (start + compressedSize > archive.length) {
    throw new ZipError('The zip archive is truncated.');
  }

  return archive.subarray(start, start + compressedSize);
}

function inflate(name: string, method: number, compressed: Buffer, size: number): Buffer {
  if (method === STORED) {
    return compressed;
  }
  if (method !== DEFLATED) {
    throw new ZipError(`The zip entry "${name}" uses compression method ${method}, which is not supported.`);
  }
  if (size === 0) {
    return Buffer.alloc(0);
  }

  try {
    return inflateRawSync(compressed, { maxOutputLength: size });
  } catch {
    throw new ZipError(`The zip entry "${name}" is corrupt.`);
  }
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { readZip, ZipError } from '../zip.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STORED = 0;
const DEFLATED = 8;

/** Two pages rasterized by pdf-services: entries written as a stream, with data descriptors. */
const pdfServicesZip = () => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/pdf-services-pages.zip'));

interface TestEntry {
  name: string;
  data: Buffer;
  method?: number;
  flags?: number;
}

/** A zip laid out the plain way, with the sizes in every local header. */
function buildZip(entries: TestEntry[], comment = ''): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? STORED;
    const body = method === DEFLATED ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const commentBytes = Buffer.from(comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);

  return Buffer.concat([...parts, centralDirectory, end, commentBytes]);
}

describe('readZip', () => {
  it('reads the page images pdf-services sends, in order', () => {
    const entries = readZip(pdfServicesZip());

    expect(entries.map(entry => entry.name)).toEqual(['page_001.png', 'page_002.png']);
    for (const entry of entries) {
      expect(entry.data.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      expect(entry.data.length).toBe(196);
    }
    expect(entries[0].data.equals(entries[1].data)).toBe(false);
  });

  it('reads stored and deflated entries', () => {
    const stored = Buffer.from('stored page');
    const deflated = Buffer.from('deflated page '.repeat(50));

    const entries = readZip(buildZip([
      { name: 'one.txt', data: stored },
      { name: 'two.txt', data: deflated, method: DEFLATED },
    ]));

    expect(entries).toEqual([
      { name: 'one.txt', data: stored },
      { name: 'two.txt', data: deflated },
    ]);
  });

  it('finds the central directory behind an archive comment', () => {
    const data = Buffer.from('page');

    expect(readZip(buildZip([{ name: 'page.txt', data }], 'a comment'))).toEqual([{ name: 'page.txt', data }]);
  });

  it('leaves directories out', () => {
    const data = Buffer.from('page');

    const entries = readZip(buildZip([
      { name: 'pages/', data: Buffer.alloc(0) },
      { name: 'pages/page_001.png', data },
    ]));

    expect(entries).toEqual([{ name: 'pages/page_001.png', data }]);
  });

  it('reads an empty entry', () => {
    expect(readZip(buildZip([{ name: 'empty.txt', data: Buffer.alloc(0), method: DEFLATED }])))
      .toEqual([{ name: 'empty.txt', data: Buffer.alloc(0) }]);
  });

  it('refuses data that is not a zip archive', () => {
    expect(() => readZip(Buffer.from('not a zip'))).toThrow(new ZipError('The data is not a zip archive.'));
    expect(() => readZip(Buffer.alloc(64, 1))).toThrow(new ZipError('The data is not a zip archive.'));
  });

  it('refuses an archive cut short', () => {
    const archive = pdfServicesZip();

    expect(() => readZip(archive.subarray(0, archive.length - 30))).toThrow(ZipError);
    expect(() => readZip(archive.subarray(200))).toThrow(ZipError);
  });

  it('refuses an entry whose data does not match its checksum', () => {
    const archive = buildZip([{ name: 'page.txt', data: Buffer.from('page') }]);
    archive[30 + 'page.txt'.length] ^= 0xff;

    expect(() => readZip(archive)).toThrow(new ZipError('The zip entry "page.txt" is corrupt.'));
  });

  it('refuses deflated data that does not inflate', () => {
    const archive = buildZip([{ name: 'page.txt', data: Buffer.from('page '.repeat(20)), method: DEFLATED }]);
    archive.fill(0xff, 30 + 'page.txt'.length, 30 + 'page.txt'.length + 4);

    expect(() => readZip(archive)).toThrow(new ZipError('The zip entry "page.txt" is corrupt.'));
  });

  it('refuses an encrypted entry', () => {
    const archive = buildZip([{ name: 'secret.png', data: Buffer.from('page'), flags: 0x1 }]);

    expect(() => readZip(archive)).toThrow(new ZipError('The zip entry "secret.png" is encrypted.'));
  });

  it('refuses a compression method other than stored or deflated', () => {
    const archive = buildZip([{ name: 'page.png', data: Buffer.from('page'), method: 12 }]);

    expect(() => readZip(archive))
      .toThrow(new ZipError('The zip entry "page.png" uses compression method 12, which is not supported.'));
  });

  it('refuses a Zip64 archive', () => {
    const archive = buildZip([{ name: 'page.png', data: Buffer.from('page') }]);
    archive.writeUInt16LE(0xffff, archive.length - 22 + 10);

    expect(() => readZip(archive)).toThrow(new ZipError('Zip64 archives are not supported.'));
  });
});

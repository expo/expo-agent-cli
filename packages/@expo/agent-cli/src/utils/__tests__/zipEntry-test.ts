import path from 'path';

import {
  EOCD_MAX_LENGTH,
  LOCAL_HEADER_MAX_LENGTH,
  findCentralDirectoryEntry,
  parseEndOfCentralDirectory,
  readLocalZipEntry,
  readZipEntry,
} from '../zipEntry';

// The fixtures live on the real disk; `fs` is memfs in this suite.
const realFs = await vi.importActual<typeof import('fs')>('node:fs');

function loadFixture(name: string): Buffer {
  return realFs.readFileSync(path.join(__dirname, '..', '..', '__fixtures__', 'zip', name));
}

describe(readZipEntry, () => {
  it.each([
    [
      'a deflated entry',
      'fixture-deflated.zip',
      'assets/app.fingerprint',
      'test-fingerprint-hash-'.repeat(50),
    ],
    ['a stored entry', 'fixture-stored.zip', 'assets/app.fingerprint', 'test-fingerprint-hash'],
    ['a later entry in the central directory', 'fixture-stored.zip', 'stored.txt', 'stored content'],
  ])(`reads %s`, (_description, fixture, entryName, expected) => {
    const contents = readZipEntry(loadFixture(fixture), entryName);
    expect(contents?.toString('utf8')).toBe(expected);
  });

  it(`returns null for a missing entry`, () => {
    expect(readZipEntry(loadFixture('fixture-stored.zip'), 'assets/missing')).toBeNull();
  });

  it(`throws on a buffer that is not a zip`, () => {
    expect(() => readZipEntry(Buffer.from('definitely not a zip archive'), 'x')).toThrow();
  });

  // Packer tools append comments to APKs, and the signature bytes may occur inside one.
  it(`reads an archive whose comment contains the EOCD signature bytes`, () => {
    const zip = loadFixture('fixture-stored.zip');
    const comment = Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18, 0x41)]);
    const contents = readZipEntry(withArchiveComment(zip, comment), 'assets/app.fingerprint');
    expect(contents?.toString('utf8')).toBe('test-fingerprint-hash');
  });
});

/** Append an archive comment by extending the fixture's empty EOCD comment field. */
function withArchiveComment(zip: Buffer, comment: Buffer): Buffer {
  const commented = Buffer.concat([zip, comment]);
  commented.writeUInt16LE(comment.length, zip.length - 2);
  return commented;
}

describe(parseEndOfCentralDirectory, () => {
  function eocdRecord({ entryCount = 1, size = 46, offset = 0 } = {}): Buffer {
    const record = Buffer.alloc(22);
    record.writeUInt32LE(0x06054b50, 0);
    record.writeUInt16LE(entryCount, 8);
    record.writeUInt16LE(entryCount, 10);
    record.writeUInt32LE(size, 12);
    record.writeUInt32LE(offset, 16);
    return record;
  }

  it(`accepts a non-ZIP64 archive with exactly 0xffff entries`, () => {
    const tail = Buffer.concat([
      Buffer.alloc(40),
      eocdRecord({ entryCount: 0xffff, size: 100, offset: 200 }),
    ]);
    expect(parseEndOfCentralDirectory(tail)).toEqual({ entryCount: 0xffff, offset: 200, size: 100 });
  });

  it(`rejects a ZIP64 archive, identified by its EOCD locator`, () => {
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const tail = Buffer.concat([locator, eocdRecord({ entryCount: 0xffff })]);
    expect(() => parseEndOfCentralDirectory(tail)).toThrow('ZIP64');
  });

  it(`rejects the 0xffffffff central-directory offset sentinel`, () => {
    const tail = Buffer.concat([Buffer.alloc(40), eocdRecord({ offset: 0xffffffff })]);
    expect(() => parseEndOfCentralDirectory(tail)).toThrow('ZIP64');
  });
});

describe('ranged reading', () => {
  it(`extracts an entry from the partial buffers a ranged reader fetches`, () => {
    const zip = loadFixture('fixture-deflated.zip');

    const tailLength = Math.min(zip.length, EOCD_MAX_LENGTH);
    const directory = parseEndOfCentralDirectory(zip.subarray(zip.length - tailLength));

    const location = findCentralDirectoryEntry(
      zip.subarray(directory.offset, directory.offset + directory.size),
      directory.entryCount,
      'assets/app.fingerprint'
    )!;

    const windowLength = Math.min(
      LOCAL_HEADER_MAX_LENGTH + location.compressedSize,
      zip.length - location.localHeaderOffset
    );
    const local = zip.subarray(
      location.localHeaderOffset,
      location.localHeaderOffset + windowLength
    );

    expect(readLocalZipEntry(local, location).toString('utf8')).toBe(
      'test-fingerprint-hash-'.repeat(50)
    );
  });
});

import fs from 'node:fs';
import path from 'node:path';

import { spawnCaptureBufferAsync } from '../../src/utils/spawnCapture';
import { readZipEntry } from '../../src/utils/zipEntry';

// Runs real pipes on every host, including the tier0-windows job. Bytes above 0x7f and NUL must
// survive capture before the ZIP parser sees them; a text round trip corrupts compressed entries.
describe('binary subprocess capture', () => {
  it.each(['fixture-stored.zip', 'fixture-deflated.zip'])(
    'reads %s across a real process boundary',
    async (fixture) => {
      const filename = path.resolve(__dirname, '../../src/__fixtures__/zip', fixture);
      const expected = fs.readFileSync(filename);
      const result = await spawnCaptureBufferAsync(
        process.execPath,
        ['-e', 'process.stdout.write(require("fs").readFileSync(process.argv[1]))', filename],
        { timeoutMs: 10_000 }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toEqual(expected);
      expect(readZipEntry(result.stdout, 'assets/app.fingerprint')).toEqual(
        readZipEntry(expected, 'assets/app.fingerprint')
      );
    }
  );
});

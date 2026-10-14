import fs from 'node:fs';
import path from 'node:path';
import { spawnExpoAsync, runExpoAsync } from '../../src/utils/expoCli';
import { getTemporaryPath, installStubBinAsync } from '../utils';

it.each(['57.0.21', 'unrecognized'])(
  'preserves old or unknown Expo transport (%s), including its successful bounded exit',
  async (version) => {
    const root = getTemporaryPath();
    fs.mkdirSync(root, { recursive: true });
    const script = path.join(root, 'expo.js');
    fs.writeFileSync(
      script,
      `
    const fs = require('fs');
    if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); }
    else {
      // Expo CLI 57.0.21 events/stream.js fsyncs a numeric LOG_EVENTS target.
      if (/^\\d+$/.test(process.env.LOG_EVENTS || '')) fs.fsyncSync(Number(process.env.LOG_EVENTS));
      console.log('› Installing on device');
      console.log('installation finished');
    }
  `
    );
    await installStubBinAsync(path.join(root, 'node_modules/.bin'), 'expo', script);
    const onEvent = vi.fn();
    const { result } = await spawnExpoAsync(root, ['run:ios', '--no-bundler'], { onEvent });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('installation finished');
    expect(onEvent).not.toHaveBeenCalled();
    expect(await runExpoAsync(root, ['run:ios', '--no-bundler'], onEvent)).toBe(0);
  }
);

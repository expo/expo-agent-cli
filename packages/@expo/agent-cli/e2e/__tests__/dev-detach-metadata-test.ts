import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { lockAddressFor } from '../../src/devLock/address';
import { detachedRunFixture } from '../detachedRunFixture';
import { executeAgentCliAsync } from '../utils';

it.each(['empty', 'live', 'interrupted'] as const)(
  'regular Finder metadata preserves %s ownership evidence',
  async (state) => {
    const f = await detachedRunFixture();
    const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
    try {
      if (state === 'live') expect((await f.start()).exitCode).toBe(0);
      fs.mkdirSync(directory, { recursive: true });
      if (state === 'interrupted') {
        const id = randomUUID();
        fs.writeFileSync(
          path.join(directory, `owner-${id}.json`),
          JSON.stringify({
            id,
            pid: 2147483647,
            logFile: 'interrupted.log',
            endpoint: lockAddressFor(f.root, { name: `detached-${id}` }).address,
          })
        );
      }
      fs.writeFileSync(path.join(directory, '.DS_Store'), 'Finder metadata');
      const result =
        state === 'live'
          ? await executeAgentCliAsync(
              f.root,
              ['dev', '--android', '--local', '--go', '--no-open', '--json'],
              {
                env: {
                  __EXPO_AGENT_CLI_DETACHED: '1',
                  __EXPO_AGENT_CLI_DETACHED_ATTEMPT: randomUUID(),
                },
                reject: false,
              }
            )
          : await f.start();
      if (state === 'empty') expect(result.exitCode, result.all).toBe(0);
      else {
        expect(result.exitCode, result.all).toBe(20);
        if (state === 'live') expect(JSON.parse(result.stdout).error.code).toBe('DEV_START_BUSY');
        else expect(result.stdout).toContain('dev:stop --discard-run');
      }
    } finally {
      await f.cleanup();
    }
  }
);

it.each(['unknown-file', 'metadata-directory', 'metadata-symlink'] as const)(
  'unexpected ownership entry %s remains intact',
  async (kind) => {
    const f = await detachedRunFixture();
    const directory = path.join(f.root, '.expo', 'dev', 'detached-run');
    fs.mkdirSync(directory, { recursive: true });
    const entry = path.join(directory, kind === 'unknown-file' ? 'unknown' : '.DS_Store');
    if (kind === 'metadata-directory') fs.mkdirSync(entry);
    else if (kind === 'metadata-symlink') fs.symlinkSync(directory, entry, 'junction');
    else fs.writeFileSync(entry, 'unknown');
    try {
      const refused = await f.start();
      expect(refused.exitCode, refused.all).toBe(20);
      expect(JSON.parse(refused.stdout).error.code).toBe('DEV_START_UNCERTAIN');
      expect(fs.lstatSync(entry)).toBeDefined();
    } finally {
      await f.cleanup();
    }
  }
);

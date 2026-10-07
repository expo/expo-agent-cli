// Run by registry-test under bun, one process per role, with the real file system. `touch` holds
// the claim of the device SIM and touches it in a tight loop; `allocate` asks for a device for
// another worktree all the while. Each prints one JSON line of what it saw.
import fs from 'fs';

import { allocateDeviceAsync } from '../../allocate';
import { touchClaim, writeClaim } from '../../registry';
import type { DeviceClaim } from '../../types';

const [role, projectRoot, log, startAt, stopAt] = process.argv.slice(2) as [
  'touch' | 'allocate',
  string,
  string,
  string,
  string,
];

const report = (result: object) =>
  fs.appendFileSync(log, `${JSON.stringify({ role, pid: process.pid, ...result })}\n`);

void (async () => {
  const held: DeviceClaim = {
    backend: 'local-ios',
    platform: 'ios',
    id: 'SIM',
    projectRoot,
    pid: process.pid,
    claimedAt: new Date(Number(startAt)).toISOString(),
    touchedAt: new Date().toISOString(),
    created: false,
    booted: false,
  };
  if (role === 'touch') {
    try {
      writeClaim(held);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
  }
  while (Date.now() < Number(startAt)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  if (role === 'touch') {
    let touches = 0;
    let lost = 0;
    while (Date.now() < Number(stopAt)) {
      touches++;
      if (touchClaim(held) == null) {
        lost++;
      }
    }
    report({ touches, lost });
    return;
  }

  let tries = 0;
  let outcome = 'exhausted';
  while (Date.now() < Number(stopAt) && outcome === 'exhausted') {
    tries++;
    try {
      const allocation = await allocateDeviceAsync({
        projectRoot,
        platform: 'ios',
        backend: 'local-ios',
        listDevices: async () => [{ id: 'SIM', state: 'booted' as const }],
        capacity: 0,
        probeLock: async () => null,
      });
      outcome = allocation.kind;
    } catch (error: unknown) {
      outcome = `threw ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
    }
  }
  report({ tries, outcome });
})();

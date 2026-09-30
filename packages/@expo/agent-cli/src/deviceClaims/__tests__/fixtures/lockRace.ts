// Run by registry-test under bun, one process per contender, with the real file system.
import fs from 'fs';

import { withRegistryLockAsync } from '../../registry';

const [log, startAt] = process.argv.slice(2) as [string, string];

void (async () => {
  while (Date.now() < Number(startAt)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await withRegistryLockAsync(async () => {
    fs.appendFileSync(log, `in ${process.pid}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    fs.appendFileSync(log, `out ${process.pid}\n`);
  });
})();

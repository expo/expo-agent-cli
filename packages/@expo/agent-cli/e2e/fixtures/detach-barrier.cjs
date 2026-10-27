// Pause a real detached CLI at its first app-config read, after its running-server check.
// Only the filesystem boundary is intercepted; ownership and spawning remain real.
const fs = require('node:fs');
const path = require('node:path');

// Advance only a waiting caller's clock; no production timeout override or real two-minute wait.
if (process.env.DETACH_TEST_EXPIRE && process.env.__EXPO_AGENT_CLI_DETACHED !== '1') {
  const now = Date.now;
  Date.now = () => now() + (fs.existsSync(process.env.DETACH_TEST_EXPIRE) ? 121_000 : 0);
}

if (process.env.__EXPO_AGENT_CLI_DETACHED === '1' && process.argv[2] === 'dev') {
  const directory = process.env.DETACH_TEST_BARRIER;
  const mark = (name) => fs.writeFileSync(path.join(directory, `${name}-${process.pid}`), '');
  mark('child');
  process.on('exit', () => mark('exited'));
  if (process.env.DETACH_TEST_BOOT_BARRIER === '1') {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(directory, 'release-boot'))) {
      if (Date.now() > deadline) throw new Error('Test did not release child bootstrap');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  if (process.env.DETACH_TEST_RECLAIM_BARRIER === '1') {
    const remove = fs.rmSync;
    fs.rmSync = function (file, ...args) {
      if (
        path.basename(path.dirname(String(file))) === 'detached-run' &&
        path.basename(String(file)).startsWith('owner-')
      ) {
        mark('reclaim');
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(path.join(directory, `release-reclaim-${process.pid}`))) {
          if (Date.now() > deadline) throw new Error('Test did not release stale recovery');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      return remove.call(this, file, ...args);
    };
  }
  if (process.env.DETACH_TEST_CLAIM_BARRIER === '1') {
    const rename = fs.renameSync;
    fs.renameSync = function (from, to) {
      const result = rename.call(this, from, to);
      if (path.basename(String(to)) === 'detached-run') {
        mark('claimed');
        const deadline = Date.now() + 30_000;
        while (!fs.existsSync(path.join(directory, 'release-claim'))) {
          if (Date.now() > deadline) throw new Error('Test did not release ownership barrier');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
      return result;
    };
  }
  const readFile = fs.readFileSync;
  fs.readFileSync = function (file, ...args) {
    if (String(file) === path.join(process.cwd(), 'app.json')) {
      mark('blocked');
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(path.join(directory, 'release'))) {
        if (Date.now() > deadline) throw new Error('Test did not release app-config barrier');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    return readFile.call(this, file, ...args);
  };
}

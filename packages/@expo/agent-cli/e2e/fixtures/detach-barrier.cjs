// Pause a real detached CLI at its first app-config read, after its running-server check.
// Only the filesystem boundary is intercepted; ownership and spawning remain real.
const fs = require('node:fs');
const path = require('node:path');

if (process.env.__EXPO_AGENT_CLI_DETACHED === '1' && process.argv[2] === 'dev') {
  const directory = process.env.DETACH_TEST_BARRIER;
  const mark = (name) => fs.writeFileSync(path.join(directory, `${name}-${process.pid}`), '');
  mark('child');
  process.on('exit', () => mark('exited'));
  const readFile = fs.promises.readFile;
  fs.promises.readFile = async function (file, ...args) {
    if (String(file) === path.join(process.cwd(), 'app.json')) {
      mark('blocked');
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(path.join(directory, 'release'))) {
        if (Date.now() > deadline) throw new Error('Test did not release app-config barrier');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return readFile.call(this, file, ...args);
  };
}

// Delay a real cleanup at the filesystem boundary, after its liveness/stop checks.
// Only the captured fixture marker is intercepted; replacement ownership remains real.
const fs = require('node:fs');
const unlink = fs.unlinkSync;
fs.unlinkSync = function (file) {
  if (String(file) === process.env.OWNERSHIP_TEST_REMOVE) {
    fs.writeFileSync(process.env.OWNERSHIP_TEST_PAUSED, '');
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(process.env.OWNERSHIP_TEST_RELEASE)) {
      if (Date.now() > deadline) throw new Error('Test did not release record removal');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return unlink.call(this, file);
};

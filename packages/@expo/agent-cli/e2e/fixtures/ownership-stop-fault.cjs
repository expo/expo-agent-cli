// Fail only taskkill delivery. Changing SystemRoot before Node starts breaks its crypto startup.
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  return /[\\/]taskkill\.exe$/i.test(String(command))
    ? spawn.call(this, process.execPath, ['-e', 'process.exit(1)'], options)
    : spawn.call(this, command, args, options);
};

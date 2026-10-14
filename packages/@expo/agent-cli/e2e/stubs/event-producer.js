const fs = require('node:fs');
const { events, installEventLogger, flushEventLogger } = require(process.argv[2]);
installEventLogger();
console.log('stdout preserved');
console.error('stderr preserved');
events('run')('install', { platform: 'ios', appId: 'dev.test', _d: 12 });
const timer = setInterval(async () => {
  if (fs.existsSync(process.argv[3])) {
    clearInterval(timer);
    await flushEventLogger();
  }
}, 20);

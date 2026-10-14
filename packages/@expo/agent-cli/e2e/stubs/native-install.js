// Emits the installed Expo CLI 58.1.7 contract, with explicit gates for race tests.
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const verb = args[0];
const root = process.cwd();
const config = () => JSON.parse(fs.readFileSync('app.json', 'utf8')).expo;
const write = (name, value) => fs.writeFileSync(name, value);
const delay = () => new Promise((resolve) => setTimeout(resolve, 20));
const wait = async (name) => {
  while (!fs.existsSync(name)) await delay();
};
const event = (value) => {
  const target = process.env.LOG_EVENTS;
  if (target)
    fs.appendFileSync(
      /^\d+$/.test(target) ? Number(target) : target,
      JSON.stringify({ _t: Date.now(), ...value }) + '\n'
    );
};
(async () => {
  if (verb === '--version') {
    console.log('58.1.4');
    return;
  }
  if (verb === 'fingerprint:diff') {
    console.log('[]');
    return;
  }
  if (verb === 'fingerprint:generate') {
    console.log(JSON.stringify({ hash: 'input-' + (config().input ?? 'A'), sources: [] }));
    return;
  }
  if (verb === 'prebuild') {
    write('prebuild-read', config().input ?? 'A');
    if (process.env.INSTALL_CASE === 'prebuild-edit') await wait('resume-prebuild');
    if (process.env.INSTALL_CASE === 'prebuild-self-edit') {
      const c = config();
      c.input = 'B';
      write('app.json', JSON.stringify({ expo: c }));
    }
    return;
  }
  const platform = verb === 'run:ios' ? 'ios' : 'android';
  write('compiled-' + platform, String(process.pid));
  console.log('› Build Succeeded\n› Installing on test device');
  console.error('native runner stderr');
  if (process.env.INSTALL_CASE === 'compilation-edit') await wait('resume-install');
  if (process.env.INSTALL_CASE === 'failure') process.exitCode = 1;
  else if (process.env.INSTALL_CASE !== 'no-event') {
    const appId = platform === 'ios' ? config().ios.bundleIdentifier : config().android.package;
    event({ _e: 'run:install', _d: 25, platform, appId });
    event({ _e: 'run:install', _d: 25, platform, appId });
  }
  if (process.env.INSTALL_CASE === 'launch-failure') {
    process.exitCode = 1;
    return;
  }
  if (process.env.INSTALL_CASE === 'failure') return;
  const port = Number(args[args.indexOf('--port') + 1]);
  let server;
  if (port && !args.includes('--no-bundler')) {
    server = http
      .createServer((req, res) => {
        res.setHeader('X-React-Native-Project-Root', root);
        res.end(req.url === '/status' ? 'packager-status:running' : '[]');
      })
      .listen(port, '127.0.0.1');
  }
  await wait('exit-' + platform);
  server?.close();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import fs from 'node:fs';
import path from 'node:path';
import {
  collectOutput,
  executeAgentCliAsync,
  installStubBinAsync,
  killAsync,
  setupFixtureAsync,
  spawnAgentCli,
  waitForAsync,
  waitForExitAsync,
} from '../utils';

const runner = path.resolve(__dirname, '../stubs/native-install.js');
const recordPath = (root: string) => path.join(root, '.expo/agent-cli-last-build.json');
const read = (root: string) => JSON.parse(fs.readFileSync(recordPath(root), 'utf8'));
async function setup() {
  const root = await setupFixtureAsync('dev-client-fresh-app');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  config.expo.ios = { bundleIdentifier: 'dev.record' };
  config.expo.android = { package: 'dev.record' };
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(config));
  fs.writeFileSync(
    recordPath(root),
    JSON.stringify({
      ios: { hash: 'previous', sources: [] },
      android: { hash: 'previous', sources: [] },
    })
  );
  await installStubBinAsync(path.join(root, 'node_modules/.bin'), 'expo', runner);
  await installStubBinAsync(path.join(root, 'node_modules/.bin'), 'fingerprint', runner);
  return root;
}
function edit(root: string) {
  const file = path.join(root, 'app.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.expo.input = 'B';
  fs.writeFileSync(file, JSON.stringify(value));
}

it.each(['ios', 'android'])(
  'publishes %s before a serving runner can exit, and the next CLI plan reads it',
  async (platform) => {
    const root = await setup();
    const events = path.join(root, 'explicit-events.jsonl');
    const child = spawnAgentCli(root, ['dev', `--${platform}`, '--local', '--no-followups'], {
      env: { LOG_EVENTS: events },
    });
    const output = collectOutput(child);
    try {
      await wait(() => read(root)[platform].hash === 'input-A');
      expect(child.exitCode).toBeNull();
      const plan = await executeAgentCliAsync(root, ['dev', `--${platform}`, '--plan', '--json']);
      expect(plan.stdout).not.toContain('No development build recorded');
      expect(
        JSON.parse(plan.stdout).steps.some((s: { argv: string[] }) =>
          s.argv.includes(`run:${platform}`)
        )
      ).toBe(false);
      expect(fs.readFileSync(events, 'utf8')).toContain('run:install');
      expect(output.all).toContain('native runner stderr');
      const before = fs.statSync(recordPath(root)).mtimeMs;
      fs.writeFileSync(path.join(root, `exit-${platform}`), '');
      await waitForExitAsync(child, output);
      expect(fs.statSync(recordPath(root)).mtimeMs).toBe(before);
    } finally {
      await killAsync(child);
    }
  }
);

it.each(['failure', 'launch-failure'])(
  'keeps installation and launch outcomes separate: %s',
  async (mode) => {
    const root = await setup();
    await executeAgentCliAsync(root, ['dev', '--ios', '--local', '--no-followups'], {
      reject: false,
      env: { INSTALL_CASE: mode },
    });
    expect(read(root).ios.hash).toBe(mode === 'launch-failure' ? 'input-A' : 'previous');
  }
);

it('does not promote Installing or cancellation to a completed build', async () => {
  const root = await setup();
  const child = spawnAgentCli(root, ['dev', '--ios', '--local'], {
    env: { INSTALL_CASE: 'no-event' },
  });
  collectOutput(child);
  try {
    await wait(() => fs.existsSync(path.join(root, 'compiled-ios')));
    await killAsync(child);
    expect(read(root).ios.hash).toBe('previous');
  } finally {
    await killAsync(child);
  }
});

it.each(['prebuild-edit', 'prebuild-self-edit', 'compilation-edit'])(
  'rejects changed inputs: %s',
  async (mode) => {
    const root = await setup();
    const child = spawnAgentCli(root, ['dev', '--ios', '--local'], { env: { INSTALL_CASE: mode } });
    const output = collectOutput(child);
    try {
      if (mode === 'prebuild-edit') {
        await wait(() => fs.existsSync(path.join(root, 'prebuild-read')));
        edit(root);
        fs.writeFileSync(path.join(root, 'resume-prebuild'), '');
      } else if (mode === 'compilation-edit') {
        await wait(() => fs.existsSync(path.join(root, 'compiled-ios')));
        edit(root);
        fs.writeFileSync(path.join(root, 'resume-install'), '');
        await wait(() => output.all.includes('freshness is unknown'));
        fs.writeFileSync(path.join(root, 'exit-ios'), '');
      }
      await waitForExitAsync(child, output);
      expect(read(root).ios.hash).toBe('previous');
      if (mode !== 'compilation-edit') {
        expect(fs.existsSync(path.join(root, 'compiled-ios'))).toBe(false);
        expect(output.all).toContain('Native inputs changed during preparation');
      }
    } finally {
      await killAsync(child);
    }
  }
);

it('merges concurrent platform writers while all reads remain valid JSON', async () => {
  const root = await setup();
  const children = ['ios', 'android'].map((platform) =>
    spawnAgentCli(root, ['dev', `--${platform}`, '--local', '--', '--no-bundler'])
  );
  children.forEach((child) => collectOutput(child));
  try {
    await wait(() => {
      const record = read(root);
      return record.ios.hash === 'input-A' && record.android.hash === 'input-A';
    });
    expect(children.every((child) => child.exitCode == null)).toBe(true);
  } finally {
    await Promise.all(children.map((child) => killAsync(child)));
  }
});

async function wait(check: () => boolean) {
  expect(await waitForAsync(check, 15000)).toBe(true);
}

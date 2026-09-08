import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  bin,
  collectOutput,
  executeAgentCliAsync,
  installStubBinAsync,
  setupFixtureAsync,
  waitForExitAsync,
  waitForAsync,
} from '../utils';

describe('Installing agents through setup', () => {
  let scratch: string;
  let homeDir: string;
  let projectRoot: string;
  let binDir: string;
  let logPath: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    scratch = await fs.promises.realpath(
      await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-setup-'))
    );
    homeDir = path.join(scratch, 'home');
    binDir = path.join(scratch, 'bin');
    logPath = path.join(scratch, 'invocations.jsonl');
    await fs.promises.mkdir(homeDir);
    projectRoot = await fs.promises.realpath(await setupFixtureAsync('skills-app'));
    env = {
      PATH: binDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODEX_HOME: path.join(homeDir, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
      SETUP_STUB_LOG: logPath,
    };
    for (const name of ['claude', 'codex', 'bunx', 'npx']) {
      const script = path.join(scratch, `${name}.js`);
      await fs.promises.writeFile(
        script,
        `
const fs = require('node:fs');
const path = require('node:path');
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const root = process.cwd();
fs.appendFileSync(process.env.SETUP_STUB_LOG, JSON.stringify({name, args, cwd: root}) + '\\n');
const file = path.join(root, name + '-installed.json');
const print = value => console.log(JSON.stringify(value));
const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
if (name === 'claude') {
  if (args[1] === 'list') print(read() || []);
  else {
    const scope = args[args.indexOf('--scope') + 1];
    fs.writeFileSync(file, JSON.stringify([{id: 'expo@claude-plugins-official', enabled: true, scope, projectPath: root}]));
    console.log('Claude installed');
  }
} else if (name === 'codex') {
  if (args[1] === 'list') print({installed: read() || []});
  else if (args[1] === 'marketplace' && args[2] === 'list') print({marketplaces: []});
  else if (args[1] === 'marketplace') {
    if (process.env.SETUP_STUB_FAIL) { console.error('marketplace unavailable'); process.exit(1); }
    print({marketplaceName: 'expo-plugins'});
  } else {
    fs.writeFileSync(file, JSON.stringify([{pluginId: 'expo@expo-plugins', enabled: true}]));
    print({pluginId: 'expo@expo-plugins'});
  }
} else if (args.includes('list')) {
  print(read() || []);
} else {
  const target = path.join(root, '.agents', 'skills', 'expo-ui');
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(target, 'SKILL.md'), '# Expo UI');
  fs.writeFileSync(file, JSON.stringify([{name: 'expo-ui', source: 'expo/skills'}]));
  console.log('Skills installed');
}
`
      );
      await installStubBinAsync(binDir, name, script);
    }
  });

  afterEach(async () => {
    await fs.promises.rm(scratch, { recursive: true, force: true });
    await fs.promises.rm(path.dirname(projectRoot), { recursive: true, force: true });
  });

  const invocations = () =>
    fs.existsSync(logPath)
      ? fs
          .readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as { name: string; args: string[]; cwd: string })
      : [];

  async function runInteractiveAsync(
    args: string[],
    steps: { prompt: string; keys: string | null }[]
  ) {
    // Exercise Clack's real key handling over pipes, with terminal capabilities supplied by the test.
    const preload = path.join(scratch, 'tty.cjs');
    await fs.promises.writeFile(
      preload,
      `process.stdin.isTTY = true;
process.stdin.setRawMode = (raw) => raw ? process.stdin.ref() : process.stdin.unref();
process.stdout.isTTY = true;
process.stderr.isTTY = true;
process.stdout.columns = process.stderr.columns = 100;
process.stderr.rows = 40;`
    );
    const child = spawn(
      process.execPath,
      ['--require', preload, bin, 'agents:setup', ...args, '--json'],
      {
        cwd: projectRoot,
        env: { ...process.env, ...env, CI: '0', FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const output = collectOutput(child);
    const ended = waitForExitAsync(child, output);
    try {
      for (const step of steps) {
        expect(
          await waitForAsync(() => output.stderr.includes(step.prompt), 10000),
          output.all
        ).toBe(true);
        if (step.keys === null) child.stdin!.end();
        else child.stdin!.write(step.keys);
      }
      expect(await waitForAsync(() => child.exitCode !== null, 15000), output.all).toBe(true);
      return await ended;
    } finally {
      if (child.exitCode === null) child.kill();
      await ended;
    }
  }

  it('should install both plugins at home outside a project and reuse them on rerun', async () => {
    const args = ['agents:setup', '--yes', '--agent', 'claude-code', '--agent', 'codex', '--json'];
    const first = await executeAgentCliAsync(scratch, args, { env });
    const report = JSON.parse(first.stdout);
    expect(report).toMatchObject({
      projectRoot: null,
      scope: 'user',
      skills: null,
      agentsMd: null,
      errors: [],
    });
    expect(report.plugins.map((entry: { status: string }) => entry.status)).toEqual([
      'installed',
      'installed',
    ]);
    const calls = invocations();
    const registration = calls.findIndex(
      (call) => call.args.includes('marketplace') && call.args.includes('add')
    );
    const install = calls.findIndex((call) => call.args.includes('expo@expo-plugins'));
    expect(registration).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(registration);
    expect(calls.every((call) => call.cwd === homeDir)).toBe(true);
    for (const root of [scratch, homeDir]) {
      expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.expo'))).toBe(false);
    }
    fs.writeFileSync(logPath, '');
    const second = await executeAgentCliAsync(scratch, args, { env });
    expect(
      JSON.parse(second.stdout).plugins.map((entry: { status: string }) => entry.status)
    ).toEqual(['already-present', 'already-present']);
    expect(invocations().every((call) => call.args.includes('list'))).toBe(true);
  });

  it('should use Codex project skills and preserve those files through module sync and cleanup', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['agents:setup', '--yes', '--project', '--agent', 'codex', '--json'],
      { env }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      scope: 'project',
      errors: [],
      skills: { synced: true },
      agentsMd: { action: 'created' },
    });
    const add = invocations().find((call) => call.args.includes('add'))!;
    expect(add.name).toBe('bunx');
    expect(add.args).toEqual([
      'skills',
      'add',
      'expo/skills',
      '--skill',
      '*',
      '--agent',
      'codex',
      '--yes',
    ]);
    expect(invocations().some((call) => call.name === 'codex')).toBe(false);
    await executeAgentCliAsync(projectRoot, ['skills:clean', '--agent', 'codex'], { env });
    expect(fs.existsSync(path.join(projectRoot, '.agents', 'skills', 'expo-ui', 'SKILL.md'))).toBe(
      true
    );
  });

  it.each(['claude-code', 'codex'])(
    'should install the %s plugin at home by default and set up the project',
    async (agent) => {
      const result = await executeAgentCliAsync(
        projectRoot,
        ['agents:setup', '--yes', '--agent', agent, '--json'],
        { env }
      );
      expect(JSON.parse(result.stdout)).toMatchObject({
        projectRoot,
        scope: 'user',
        plugins: [{ agent, provider: agent === 'codex' ? 'codex' : 'claude', status: 'installed' }],
        errors: [],
        skills: { synced: true },
        agentsMd: { action: 'created' },
      });
      expect(invocations().every((call) => call.cwd === homeDir)).toBe(true);
    }
  );

  it('should use npx when bunx is unavailable', async () => {
    await fs.promises.rm(path.join(binDir, 'bunx'));
    await fs.promises.rm(path.join(binDir, 'bunx.cmd'));
    const result = await executeAgentCliAsync(
      scratch,
      ['agents:setup', '--yes', '--agent', 'cursor', '--json'],
      { env }
    );
    expect(JSON.parse(result.stdout).errors).toEqual([]);
    expect(invocations().find((call) => call.args.includes('add'))?.args).toEqual([
      '--yes',
      'skills',
      'add',
      'expo/skills',
      '--skill',
      '*',
      '--agent',
      'cursor',
      '--yes',
      '--global',
    ]);
  });

  it('should install skills in a fresh app and report missing project dependencies', async () => {
    const freshApp = path.join(scratch, 'fresh app');
    await fs.promises.mkdir(freshApp);
    await fs.promises.writeFile(
      path.join(freshApp, 'package.json'),
      JSON.stringify({ name: 'fresh-app', dependencies: { expo: '^56.0.0' } })
    );
    const result = await executeAgentCliAsync(
      freshApp,
      ['agents:setup', '--yes', '--project', '--agent', 'cursor', '--json'],
      { env, reject: false }
    );
    expect(result.exitCode).toBe(20);
    expect(JSON.parse(result.stdout)).toMatchObject({
      projectRoot: freshApp,
      plugins: [{ status: 'installed' }],
      skills: null,
      agentsMd: { action: 'created' },
      errors: [expect.stringContaining('Install the project dependencies')],
    });
  });

  it('should reject project installation outside an Expo app without writes', async () => {
    const result = await executeAgentCliAsync(
      scratch,
      ['agents:setup', '--project', '--yes', '--agent', 'codex', '--json'],
      { env, reject: false }
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: 'BAD_ARGS',
      message: expect.stringContaining('No Expo project'),
    });
    expect(invocations()).toEqual([]);
    expect(fs.existsSync(path.join(scratch, 'AGENTS.md'))).toBe(false);
  });

  it('should require consent without invoking an installer in a noninteractive run', async () => {
    const result = await executeAgentCliAsync(scratch, ['agents:setup', '--json'], {
      env,
      reject: false,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe('SETUP_CONFIRMATION_REQUIRED');
    expect(invocations()).toEqual([]);
  });

  it('should preserve independent project setup when marketplace installation fails', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['agents:setup', '--yes', '--agent', 'codex', '--json'],
      { env: { ...env, SETUP_STUB_FAIL: '1' }, reject: false }
    );
    expect(result.exitCode).toBe(20);
    expect(JSON.parse(result.stdout)).toMatchObject({
      plugins: [{ status: 'failed' }],
      skills: { synced: true },
      agentsMd: { action: 'created' },
    });
    expect(result.stdout).toContain('marketplace unavailable');
    expect(invocations().some((call) => call.args.includes('expo@expo-plugins'))).toBe(false);
  });

  it.each([
    ['No', 'n'],
    ['default No', '\r'],
    ['Escape', '\u001b'],
    ['Ctrl-C', '\u0003'],
    ['Ctrl-D', '\u0004'],
    ['EOF', null],
  ])('should cancel on %s at confirmation without writes', async (_label, keys) => {
    const result = await runInteractiveAsync(
      ['--agent', 'claude-code', '--project'],
      [{ prompt: 'Continue with setup?', keys }]
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).cancelled).toBe(true);
    expect(result.stderr).toContain('Continue with setup?');
    expect(invocations()).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.expo', 'agent-skill-links.json'))).toBe(false);
  });

  it('should confirm home installation by default while preserving project setup', async () => {
    const result = await runInteractiveAsync(
      ['--agent', 'claude-code'],
      [{ prompt: 'Continue with setup?', keys: 'y' }]
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cancelled: false,
      scope: 'user',
      errors: [],
      skills: { synced: true },
    });
    expect(invocations().every((call) => call.cwd === homeDir)).toBe(true);
    expect(result.stderr).toContain(homeDir);
    expect(result.stderr).toContain(`Sync package skills in ${projectRoot}.`);
    expect(result.stderr).not.toContain('Where should Expo');
  });

  it('should toggle preselected agents with arrows and Space and install only the chosen agent', async () => {
    const result = await runInteractiveAsync(
      [],
      [
        { prompt: 'Which agents should Expo set up?', keys: ' \u001b[B \u001b[B \r' },
        { prompt: 'Continue with setup?', keys: 'y' },
      ]
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      agents: ['cursor'],
      scope: 'user',
      plugins: [{ agent: 'cursor', status: 'installed' }],
    });
    expect(invocations().every((call) => call.name === 'bunx')).toBe(true);
  });

  it('should require at least one selected agent before continuing', async () => {
    const result = await runInteractiveAsync(
      ['--project'],
      [
        { prompt: 'Which agents should Expo set up?', keys: ' \u001b[B\u001b[B \r' },
        { prompt: 'Please select at least one option.', keys: '\u001b' },
      ]
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).cancelled).toBe(true);
    expect(invocations()).toEqual([]);
  });

  it('should cancel agent selection before installing', async () => {
    const result = await runInteractiveAsync(
      [],
      [{ prompt: 'Which agents should Expo set up?', keys: '\u001b' }]
    );
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout).cancelled).toBe(true);
    expect(invocations()).toEqual([]);
    expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
  });
});

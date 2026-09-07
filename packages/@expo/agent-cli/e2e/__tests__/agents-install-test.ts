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
      ['agents:setup', '--yes', '--scope', 'project', '--agent', 'codex', '--json'],
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

  it('should install at home while still setting up the current project', async () => {
    const result = await executeAgentCliAsync(
      projectRoot,
      ['agents:setup', '--yes', '--scope', 'user', '--agent', 'claude-code', '--json'],
      { env }
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      projectRoot,
      scope: 'user',
      errors: [],
      skills: { synced: true },
      agentsMd: { action: 'created' },
    });
    expect(invocations().every((call) => call.cwd === homeDir)).toBe(true);
  });

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
      ['agents:setup', '--yes', '--scope', 'project', '--agent', 'cursor', '--json'],
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
      ['agents:setup', '--yes', '--scope', 'user', '--agent', 'codex', '--json'],
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

  it.each(['n\n', ''])(
    'should cancel on a declined interactive confirmation or EOF (%j) without writes',
    async (answer) => {
      // Give the pipe the terminal capabilities the entry point checks; answers still cross stdin.
      const preload = path.join(scratch, 'tty.cjs');
      await fs.promises.writeFile(
        preload,
        'process.stdin.isTTY = true; process.stdout.isTTY = true;'
      );
      const child = spawn(
        process.execPath,
        [
          '--require',
          preload,
          bin,
          'agents:setup',
          '--agent',
          'claude-code',
          '--scope',
          'project',
          '--json',
        ],
        {
          cwd: projectRoot,
          env: { ...process.env, ...env, CI: '0', FORCE_COLOR: '0' },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      const output = collectOutput(child);
      const ended = waitForExitAsync(child, output);
      child.stdin!.end(answer);
      const result = await ended;
      expect(result.exitCode, result.all).toBe(0);
      expect(JSON.parse(result.stdout).cancelled).toBe(true);
      expect(result.stderr).toContain('Continue?');
      expect(invocations()).toEqual([]);
      expect(fs.existsSync(path.join(projectRoot, 'AGENTS.md'))).toBe(false);
      expect(fs.existsSync(path.join(projectRoot, '.expo', 'agent-skill-links.json'))).toBe(false);
    }
  );

  it('should accept interactive home selection and confirmation while preserving project setup', async () => {
    const preload = path.join(scratch, 'tty.cjs');
    await fs.promises.writeFile(
      preload,
      'process.stdin.isTTY = true; process.stdout.isTTY = true;'
    );
    const child = spawn(
      process.execPath,
      ['--require', preload, bin, 'agents:setup', '--agent', 'claude-code', '--json'],
      {
        cwd: projectRoot,
        env: { ...process.env, ...env, CI: '0', FORCE_COLOR: '0' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const output = collectOutput(child);
    const ended = waitForExitAsync(child, output);
    child.stdin!.end('2\nyes\n');
    const result = await ended;
    expect(result.exitCode, result.all).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      cancelled: false,
      scope: 'user',
      errors: [],
      skills: { synced: true },
    });
    expect(invocations().every((call) => call.cwd === homeDir)).toBe(true);
  });
});

import fs from 'node:fs';
import path from 'node:path';

import { installStubEasAsync, readStubEasInvocations } from '../stubEas';
import { executeAgentCliAsync, readStubExpoInvocations, setupFixtureAsync } from '../utils';

it.each([
  ['dev', '--ios', '--eas'],
  ['dev', '--ios', '--eas', '--detach'],
  ['smoke', '--ios', '--eas'],
])('stops an unlinked project before starting any environment: %j', async (...argv) => {
  const projectRoot = await setupFixtureAsync('go-app');
  await installStubEasAsync(projectRoot, { linked: false });
  // An eas.json alone is not sufficient either.
  await fs.promises.writeFile(path.join(projectRoot, 'eas.json'), '{"build":{}}');
  const result = await executeAgentCliAsync(projectRoot, [...argv, '--json'], { reject: false });
  expect(result.exitCode).toBe(7);
  expect(JSON.parse(result.stdout).error.code).toBe('EAS_PROJECT_NOT_LINKED');
  expect(result.stderr).toContain('init --id <project-id> --non-interactive');
  expect(readStubExpoInvocations(projectRoot).map(({ args }) => args)).toEqual([
    ['config', '--json'],
  ]);
  expect(readStubEasInvocations(projectRoot)).toEqual([]);
  expect(fs.existsSync(path.join(projectRoot, '.expo', 'agent-cli-dev.log'))).toBe(false);
});

it('does not require EAS setup to print a plan', async () => {
  const projectRoot = await setupFixtureAsync('go-app');
  await installStubEasAsync(projectRoot, { linked: false });
  const result = await executeAgentCliAsync(projectRoot, [
    'dev',
    '--ios',
    '--eas',
    '--plan',
    '--json',
  ]);
  expect(result.exitCode).toBe(0);
  expect(readStubExpoInvocations(projectRoot).some(({ args }) => args[0] === 'start')).toBe(false);
});

it('uses evaluated config even when the static app.json says the project is linked', async () => {
  const projectRoot = await setupFixtureAsync('go-app');
  await installStubEasAsync(projectRoot);
  const config = path.join(projectRoot, 'evaluated-config.json');
  await fs.promises.writeFile(config, '{"slug":"dynamic-unlinked"}');
  const result = await executeAgentCliAsync(projectRoot, ['dev', '--ios', '--eas', '--json'], {
    reject: false,
    env: { STUB_EXPO_CONFIG_JSON: config },
  });
  expect(result.exitCode).toBe(7);
  expect(readStubEasInvocations(projectRoot)).toEqual([]);
});

// @ref llp/0035-one-device-per-worktree.rfc.md §EAS session binding
import fs from 'node:fs';
import { CLOUD_SESSION_MISMATCH, guardedCloudArgs } from '../../src/device/cloudCommand';
import { easCliArgs, resolveEasCli } from '../../src/utils/easCli';
import { spawnSubprocessAsync } from '../../src/utils/subprocess';
import { installStubEasAsync, writeCloudSessionFileAsync } from '../stubEas';
import { installStubFingerprintAsync, setupFixtureAsync, stubExpoEnv } from '../utils';

function envFor(root: string) {
  return stubExpoEnv(root);
}
async function project(fixture = 'go-app') {
  const root = fs.realpathSync(await setupFixtureAsync(fixture));
  await installStubFingerprintAsync(root);
  await installStubEasAsync(root);
  return root;
}
it('round-trips guarded cloud target argv and refuses before running on a session mismatch', async () => {
  const root = await project();
  const sessionId = 'argv-session';
  await writeCloudSessionFileAsync(root, sessionId);
  const env = envFor(root);
  const easCli = resolveEasCli(root, { env });
  expect(easCli).not.toBeNull();

  const targetArgs = [
    'space value',
    'double"quote',
    'caret^value',
    '%PATH% value',
    'ampersand&value',
    'Unicode café 雪',
    'two\nlines',
  ];
  const target = [
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    ...targetArgs,
  ];
  const runGuarded = (expectedSessionId: string) =>
    spawnSubprocessAsync(
      easCli!.command,
      easCliArgs(easCli!, guardedCloudArgs(['simulator:exec', ...target], expectedSessionId)),
      { cwd: root, env }
    );

  const accepted = await runGuarded(sessionId);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  expect(JSON.parse(accepted.stdout)).toEqual(targetArgs);

  const refused = await runGuarded('another-session');
  expect(refused.exitCode).toBe(20);
  expect(refused.stderr).toContain(`${CLOUD_SESSION_MISMATCH} ${sessionId}`);
  expect(refused.stdout).toBe('');
});

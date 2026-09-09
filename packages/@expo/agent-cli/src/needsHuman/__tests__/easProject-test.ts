import { vol } from 'memfs';

import { spawnSubprocessAsync } from '../../utils/subprocess';
import { assertEasProjectConfiguredAsync } from '../easProject';

vi.mock('../../utils/subprocess', () => ({ spawnSubprocessAsync: vi.fn() }));
vi.mock('../../utils/expoCli', () => ({
  resolveExpoCli: () => ({ command: 'expo', args: ['config', '--json'] }),
}));

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ '/project/package.json': '{}' });
});

it.each([undefined, '', 123])('rejects a missing or invalid project ID: %s', async (projectId) => {
  vi.mocked(spawnSubprocessAsync).mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({ extra: { eas: { projectId } } }),
    stderr: '',
  });
  await expect(assertEasProjectConfiguredAsync('/project')).rejects.toMatchObject({
    code: 'EAS_PROJECT_NOT_LINKED',
    needsHuman: { detectedBy: 'preflight' },
  });
});

it('accepts the project ID from evaluated config, without requiring eas.json', async () => {
  vi.mocked(spawnSubprocessAsync).mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      extra: { eas: { projectId: 'f52a76f7-9fc7-4b59-becd-6d84e9f129d7' } },
    }),
    stderr: '',
  });
  await expect(assertEasProjectConfiguredAsync('/project')).resolves.toBeUndefined();
});

it.each([
  { exitCode: 1, stdout: '', stderr: 'Missing APP_VARIANT' },
  { exitCode: 0, stdout: 'not JSON', stderr: '' },
  { exitCode: 0, stdout: 'null', stderr: '' },
  { exitCode: null, stdout: '', stderr: '', timedOut: true },
])('does not report an unreadable config as an unlinked project', async (result) => {
  vi.mocked(spawnSubprocessAsync).mockResolvedValue(result);
  await expect(assertEasProjectConfiguredAsync('/project')).rejects.toMatchObject({
    code: 'EAS_PROJECT_CONFIG_UNREADABLE',
  });
});

it('reads the config payload when Expo events also use stdout', async () => {
  vi.mocked(spawnSubprocessAsync).mockResolvedValue({
    exitCode: 0,
    stdout:
      'event before\n' +
      JSON.stringify({
        slug: 'app',
        extra: { eas: { projectId: 'f52a76f7-9fc7-4b59-becd-6d84e9f129d7' } },
      }) +
      '\n{"event":"after"}\n',
    stderr: '',
  });
  await expect(assertEasProjectConfiguredAsync('/project')).resolves.toBeUndefined();
});

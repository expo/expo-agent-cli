import { vol } from 'memfs';
import path from 'path';

import { agentCliExpoPassthrough } from '..';
import { event } from '../../events';
import { runExpoAsync } from '../../utils/expoCli';

vi.mock('../../log');
vi.mock('../../events', () => ({ event: vi.fn(), debugEvent: vi.fn() }));
vi.mock('../../utils/expoCli', () => ({ runExpoAsync: vi.fn() }));

// path.resolve so the expectation matches what findUpProjectRootOrCwd returns on every
// platform (win32 resolves '/project' to '<drive>:\\project').
const projectRoot = path.resolve('/project');

beforeEach(() => {
  vol.reset();
  vol.fromJSON({ 'package.json': JSON.stringify({ name: 'app' }) }, projectRoot);
  vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
  vi.mocked(runExpoAsync).mockResolvedValue(0);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe(agentCliExpoPassthrough, () => {
  it(`should forward the command and its arguments to the expo CLI`, async () => {
    await agentCliExpoPassthrough('prebuild')(['--clean']);

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['prebuild', '--clean']);
  });

  it(`should forward a command with no arguments`, async () => {
    await agentCliExpoPassthrough('whoami')([]);

    expect(runExpoAsync).toHaveBeenCalledWith(projectRoot, ['whoami']);
  });

  it(`should forward the exit code of the expo CLI`, async () => {
    vi.mocked(runExpoAsync).mockResolvedValue(9);

    await agentCliExpoPassthrough('export')(['--platform', 'web']);

    expect(process.exitCode).toBe(9);
  });

  it(`should emit one event naming the forwarded command`, async () => {
    await agentCliExpoPassthrough('export')(['--platform', 'web']);

    expect(event).toHaveBeenCalledWith('expo_passthrough', {
      command: 'export',
      args: ['--platform', 'web'],
    });
  });

  it(`should run in the working directory when it is inside no project`, async () => {
    vol.reset();
    vi.spyOn(process, 'cwd').mockReturnValue('/elsewhere');

    await agentCliExpoPassthrough('whoami')([]);

    expect(runExpoAsync).toHaveBeenCalledWith('/elsewhere', ['whoami']);
  });
});

import { devStopAsync } from '../../dev/stopAsync';
import { resolveSmokeOptions } from '../resolveOptions';
import { buildSmokeDeps } from '../smokeAsync';

vi.mock('../../log');
vi.mock('../../dev/stopAsync', () => ({ devStopAsync: vi.fn(async () => 0) }));
vi.mock('../../project/probe', () => ({ probeProjectStateAsync: vi.fn(async () => ({})) }));
vi.mock('../../plan/resolveAsync', () => ({
  resolveStartPlanAsync: vi.fn(async () => ({
    plan: {
      rule: 'dev-client-stale',
      buildLocation: { runsOn: 'eas', selection: { implicit: true, because: 'no Xcode' } },
    },
  })),
}));

it('a start refused before acquisition keeps the bound device on cleanup', async () => {
  const deps = buildSmokeDeps('/work/app', resolveSmokeOptions(['--ios']));
  const start = await deps.startDevServer();
  expect(start.reason).toContain('EAS credits');
  await deps.stopDevServer();
  expect(devStopAsync).toHaveBeenCalledWith(
    '/work/app',
    expect.objectContaining({ release: false }),
    expect.anything()
  );
});

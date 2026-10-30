// @ref llp/0005-runtime-loop-tools.rfc.md §Target owner
import {
  makeDeviceInventory,
  makeTarget,
  makeTargetSelection,
} from '../../__tests__/targetSelectionFixtures';
import type { ReloadAttempt } from '../attempt';
import { markBundleSignalSync } from '../bundleSignal';
import { observeReloadAsync } from '../evidence';
import { CHURN_NOT_ASKED, prepareRungOne } from '../rungOne';

const own = makeTarget({ id: 'own-1', deviceName: 'Own sim', appId: 'host.exp.Exponent' });
const clone = makeTarget({ id: 'clone-1', deviceName: 'Clone sim', appId: 'host.exp.Exponent' });
/** A device no rule places: a broadcast may reach it, and it could fetch any bundle. */
const elsewhere = makeTarget({ id: 'far-1', deviceName: 'Ada’s phone' });
const targetSelection = makeTargetSelection({
  platform: { value: 'ios', by: 'flag' },
  device: { backend: 'local-ios', udid: 'OWN', name: 'Own sim' },
  bound: true,
});
const deviceInventory = makeDeviceInventory({
  booted: [
    { name: 'Own sim', udid: 'OWN' },
    { name: 'Clone sim', udid: 'CLONE' },
  ],
  iosBindings: [
    { udid: 'OWN', name: 'Own sim', own: true, projectRoot: '/project' },
    { udid: 'CLONE', name: 'Clone sim', own: false, projectRoot: '/other' },
  ],
});
/** Rung 1 is `Page.reload`, and no bundle may count. */
const besideClone = prepareRungOne([own, clone], targetSelection, deviceInventory);
/** Rung 1 is the broadcast, and no bundle may count. */
const besideUnplaced = prepareRungOne(
  [own, elsewhere],
  makeTargetSelection({ platform: { value: 'ios', by: 'flag' } }),
  deviceInventory
);
it('places both runs where no bundle may count', () => {
  expect([besideClone.policy, besideUnplaced.policy]).toMatchObject([
    { mechanism: 'page-reload', bundlePlatforms: [] },
    { mechanism: 'broadcast', bundlePlatforms: [] },
  ]);
});

const attempt = (method: ReloadAttempt['method'], ok: boolean, delivered?: boolean) =>
  ({
    method,
    ok,
    delivered,
    reason: 'x',
    leftAppStopped: null,
    ...(method === 'page-reload' ? { outcomes: [] } : {}),
  }) as ReloadAttempt;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('whether the shared observations are watched after the mechanism that settled', () => {
  it.each([
    {
      name: 'pinned --method dev-server beside a skipped app: Page.reload answered',
      prepared: besideClone,
      attempts: [attempt('page-reload', false, true)],
      unwatched: 'nothing-can-prove',
    },
    {
      name: 'a proved broadcast',
      prepared: besideUnplaced,
      attempts: [attempt('dev-server', true)],
      unwatched: null,
    },
    {
      name: 'a delivered or acted broadcast',
      prepared: besideUnplaced,
      attempts: [attempt('dev-server', false, true)],
      unwatched: null,
    },
    {
      name: 'Page.reload, then a local relaunch',
      prepared: besideClone,
      attempts: [attempt('page-reload', false, false), attempt('device', true)],
      mechanismProof: 'app-relaunch' as const,
      unwatched: 'nothing-can-prove',
    },
    {
      name: 'Page.reload, then a cloud relaunch',
      prepared: besideClone,
      attempts: [attempt('page-reload', false, false), attempt('device', true)],
      unwatched: 'nothing-can-prove',
    },
    {
      name: 'an unread target list, then a relaunch',
      prepared: besideUnplaced,
      attempts: [attempt('dev-server', false), attempt('device', true)],
      unwatched: 'nothing-can-prove',
    },
    {
      name: '--method device',
      prepared: besideClone,
      attempts: [attempt('device', true)],
      unwatched: 'nothing-can-prove',
    },
    {
      name: '--method runtime',
      prepared: besideClone,
      attempts: [attempt('runtime', true)],
      unwatched: null,
    },
  ])('$name', async ({ prepared, attempts, mechanismProof = null, unwatched }) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(prepared.targets), { status: 200 })) as typeof fetch;

    const seen = await observeReloadAsync('http://127.0.0.1:8081', '/project', {
      prepared,
      mechanismProof,
      churn: CHURN_NOT_ASKED,
      attempts,
      bundleMark: markBundleSignalSync('/project'),
      timeoutMs: 300,
    });

    expect(seen.unwatched).toBe(unwatched);
  });
});

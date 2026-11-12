import { lockInfo } from '../../devLock/__tests__/fakeLock';
import type { DetachedObservation } from '../devRunTypes';
import { selectStopTarget } from '../stopTarget';
import type { StopTargetConstraint } from '../stopTypes';

const lock = lockInfo({ pid: 11, port: 8081 });
const owner: Extract<DetachedObservation, { kind: 'live' }> = {
  kind: 'live',
  attempt: { id: 'owner', pid: 22, logFile: '/owner.log', request: null },
  progress: { kind: 'starting', metro: { kind: 'awaiting', plannedPort: 8082 } },
};
const project: StopTargetConstraint = { kind: 'project' };
const child = { pid: 22, exitCode: null, signalCode: null };
const owned: StopTargetConstraint = { kind: 'owned-child', child };
const interrupted: DetachedObservation = { kind: 'interrupted', attempt: owner.attempt };
const unknown: DetachedObservation = { ...owner, progress: { kind: 'unknown' } };

type Case = [
  string,
  Parameters<typeof selectStopTarget>,
  ReturnType<typeof selectStopTarget>['kind'],
  number | null,
];
it.each<Case>([
  [
    'foreground by default beside another live owner',
    [lock, owner, null, project],
    'foreground',
    11,
  ],
  ['foreground at its explicit port', [lock, owner, 8081, project], 'foreground', 11],
  ['owner at its independent requested port', [lock, owner, 8082, project], 'owner', 22],
  ['foreground beside interrupted admission', [lock, interrupted, null, project], 'foreground', 11],
  [
    'same-PID silent owner never falls back to its lock',
    [lockInfo({ pid: 22 }), unknown, null, project],
    'owner',
    22,
  ],
  ['prelock captured child', [null, owner, null, owned], 'owner', 22],
  ['captured child beside another foreground lock', [lock, owner, null, owned], 'owner', 22],
  [
    'another child has no authority',
    [null, owner, null, { kind: 'owned-child', child: { ...child, pid: 33 } }],
    'skip',
    null,
  ],
  [
    'exited child has no authority',
    [null, owner, null, { kind: 'owned-child', child: { ...child, exitCode: 0 } }],
    'skip',
    null,
  ],
  [
    'signalled child has no authority',
    [null, owner, null, { kind: 'owned-child', child: { ...child, signalCode: 'SIGTERM' } }],
    'skip',
    null,
  ],
  ['child constraint does not grant the other port', [lock, owner, 8081, owned], 'skip', null],
])('selects %s', (_name, input, kind, pid) => {
  const selected = selectStopTarget(...input);
  expect(selected.kind).toBe(kind);
  expect(
    selected.kind === 'owner'
      ? selected.observation.attempt?.pid
      : selected.kind === 'foreground' || selected.kind === 'locked'
        ? selected.lock.pid
        : null
  ).toBe(pid);
});

it('does not infer a port for an owner with unknown progress', () => {
  const selected = selectStopTarget(null, unknown, 8082, project);
  expect(selected).toMatchObject({
    kind: 'owner',
    observation: { kind: 'uncertain', attempt: owner.attempt },
  });
});

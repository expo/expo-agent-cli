import { lockInfo } from '../../devLock/__tests__/fakeLock';
import type { DetachedObservation, RunProgress } from '../devRunTypes';
import { decideRecovery, renderRecovery } from '../recovery';
import { recoveryRequestFor } from '../recoveryRequest';

const request = recoveryRequestFor('ios', null);
const attempt = { id: 'attempt-one', pid: 1234, logFile: '/logs/attempt-one.log', request };
const metro = { kind: 'awaiting', plannedPort: null } as const;
const server = { url: 'http://127.0.0.1:8081', port: 8081 };

it.each<RunProgress>([
  { kind: 'starting', metro },
  { kind: 'stopping', metro },
  { kind: 'unaccounted', metro, detail: 'The submitted session has no confirmed receipt.' },
  { kind: 'unknown' },
])('observes live $kind evidence regardless of published lock readiness', (progress) => {
  const action = decideRecovery({
    ownership: { kind: 'live', attempt, progress },
    lock: lockInfo({ easOpenFinished: true }),
    request,
    needsStart: true,
  })!;
  expect(renderRecovery(action)).toMatchObject({
    command: 'npx @expo/agent-cli dev:logs',
    recovery: { kind: 'observe', attempt: { id: attempt.id, logFile: attempt.logFile } },
  });
});

it.each([
  { name: 'unfinished', lock: lockInfo({ easPlatform: 'ios', easOpenFinished: false }) },
  {
    name: 'old unfinished',
    lock: lockInfo({
      easPlatform: 'ios',
      easOpenFinished: false,
      startedAt: '2000-01-01T00:00:00.000Z',
    }),
  },
])('observes foreground EAS with $name evidence and no detached log', ({ lock }) => {
  const action = decideRecovery({ lock, request, needsStart: true })!;
  expect(renderRecovery(action)).toMatchObject({
    command: 'npx @expo/agent-cli status',
    recovery: { kind: 'observe' },
  });
});

it.each<{ ownership: DetachedObservation; kind: string }>([
  { ownership: { kind: 'interrupted', attempt }, kind: 'discard-record' },
  {
    ownership: { kind: 'uncertain', attempt, detail: 'The endpoint did not answer.' },
    kind: 'uncertain',
  },
  {
    ownership: { kind: 'live', attempt, progress: { kind: 'running', server } },
    kind: 'stop-and-start',
  },
  { ownership: { kind: 'none' }, kind: 'start' },
])('uses $kind only from its ownership evidence', ({ ownership, kind }) => {
  const action = decideRecovery({ ownership, lock: null, request, needsStart: true })!;
  expect(action.kind).toBe(kind);
});

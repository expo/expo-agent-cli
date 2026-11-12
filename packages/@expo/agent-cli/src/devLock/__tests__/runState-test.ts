import { nextRunState, type RunState } from '../runState';

const published = {
  type: 'published',
  phase: 'building',
  port: 8081,
  source: 'arg',
  since: 1,
  easPlatform: null,
} as const;

it('keeps publication state separate from the work lifetime', () => {
  const building = nextRunState({ phase: 'unlocked' }, published)!;
  const serving = nextRunState(building, { type: 'status-answered' })!;
  expect(serving).toMatchObject({ phase: 'serving', port: 8081 });
  expect(nextRunState(serving, { type: 'port-reported', port: 8082 })).toMatchObject({
    port: 8082,
    source: 'reported',
  });
  expect(nextRunState(serving, { type: 'foreign-port' })).toEqual({ phase: 'unlocked' });
});

it('never republishes a released lock', () => {
  const released: RunState = { phase: 'released' };
  expect(nextRunState(released, published)).toBeNull();
  expect(nextRunState(released, { type: 'run-ended' })).toBe(released);
});

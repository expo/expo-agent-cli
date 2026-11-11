// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — every cell of the table.

import {
  nextRunState,
  type EasOpen,
  type LockPort,
  type RunEvent,
  type RunState,
} from '../runState';

/** Where a held state points before the event. */
const HELD_AT: LockPort = { port: 8081, source: 'arg', since: 1, easPlatform: null };
/** Where a `published` points. */
const PUBLISHED_AT: LockPort = { port: 9000, source: 'default', since: 2, easPlatform: 'ios' };

/** A state as a cell names it: phase and EAS open, or `released`. */
type Cell = ['unlocked' | 'building' | 'serving', EasOpen] | ['finishing', 'running'] | 'released';
type Next = Cell | 'illegal';
const u = (easOpen: EasOpen): Cell => ['unlocked', easOpen];
const b = (easOpen: EasOpen): Cell => ['building', easOpen];
const s = (easOpen: EasOpen): Cell => ['serving', easOpen];
const f: Cell = ['finishing', 'running'];
const R: Cell = 'released';
const X: Next = 'illegal';

/** Where the lock points after each event: the event's port, Metro's report, or unchanged. */
type PortAfter = 'published' | 'reported' | 'kept';
const EVENTS: [string, RunEvent, PortAfter][] = [
  ['published building', { type: 'published', phase: 'building', ...PUBLISHED_AT }, 'published'],
  ['published serving', { type: 'published', phase: 'serving', ...PUBLISHED_AT }, 'published'],
  ['foreign-port', { type: 'foreign-port' }, 'kept'],
  ['port-reported', { type: 'port-reported', port: 8082 }, 'reported'],
  ['status-answered', { type: 'status-answered' }, 'kept'],
  ['eas-open-started', { type: 'eas-open-started' }, 'kept'],
  ['eas-open-returned', { type: 'eas-open-returned' }, 'kept'],
  ['server-exited', { type: 'server-exited' }, 'kept'],
  ['run-ended', { type: 'run-ended' }, 'kept'],
];

function state(next: Cell, at: LockPort = HELD_AT): RunState {
  if (next === 'released') return { phase: 'released' };
  const [phase, easOpen] = next;
  if (phase === 'unlocked') return { phase, easOpen };
  return phase === 'finishing' ? { phase, easOpen: 'running', ...at } : { phase, easOpen, ...at };
}

const PORT_AFTER: Record<PortAfter, LockPort> = {
  published: PUBLISHED_AT,
  reported: { ...HELD_AT, port: 8082, source: 'reported' },
  kept: HELD_AT,
};

// One row per state, one column per event in the order of EVENTS.
// oxfmt-ignore
const TABLE: [Cell, Next[]][] = [
  [u('none'),     [b('none'),     s('none'),     u('none'),     u('none'),     u('none'),     u('running'), X,              u('none'),     R]],
  [u('running'),  [b('running'),  s('running'),  u('running'),  u('running'),  u('running'),  X,            u('returned'),  u('running'),  R]],
  [u('returned'), [b('returned'), s('returned'), u('returned'), u('returned'), u('returned'), X,            X,              u('returned'), R]],
  [b('none'),     [b('none'),     s('none'),     u('none'),     b('none'),     s('none'),     b('running'), X,              b('none'),     R]],
  [b('running'),  [b('running'),  s('running'),  u('running'),  b('running'),  s('running'),  X,            b('returned'),  f,             R]],
  [b('returned'), [b('returned'), s('returned'), u('returned'), b('returned'), s('returned'), X,            X,              R,             R]],
  [s('none'),     [b('none'),     s('none'),     u('none'),     s('none'),     s('none'),     s('running'), X,              s('none'),     R]],
  [s('running'),  [b('running'),  s('running'),  u('running'),  s('running'),  s('running'),  X,            s('returned'),  f,             R]],
  [s('returned'), [b('returned'), s('returned'), u('returned'), s('returned'), s('returned'), X,            X,              R,             R]],
  [f,             [X,             X,             X,             f,             f,             X,            R,              X,             R]],
  [R,             [X,             X,             R,             R,             R,             R,            R,              R,             R]],
];

const CASES = TABLE.flatMap(([from, row]) =>
  EVENTS.map(([name, event, portAfter], column) => {
    const next = row[column]!;
    return {
      from: state(from),
      name,
      event,
      expected: next === 'illegal' ? null : state(next, PORT_AFTER[portAfter]),
    };
  })
);

describe(nextRunState, () => {
  it.each(CASES)(`$from.phase/$from.easOpen × $name`, ({ from, event, expected }) => {
    expect(nextRunState(from, event)).toEqual(expected);
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock — every cell of the table.

import { nextRunState, type OpenState, type RunEvent, type RunState } from '../runState';

const published = (phase: 'building' | 'serving'): RunEvent => ({
  type: 'published',
  phase,
  port: 8081,
  source: 'arg',
  since: 0,
  easPlatform: null,
});

const EVENTS: [string, RunEvent][] = [
  ['published building', published('building')],
  ['published serving', published('serving')],
  ['foreign-port', { type: 'foreign-port' }],
  ['port-reported', { type: 'port-reported', port: 8082 }],
  ['status-answered', { type: 'status-answered' }],
  ['open-started', { type: 'open-started' }],
  ['open-returned', { type: 'open-returned' }],
  ['server-exited', { type: 'server-exited' }],
  ['run-ended', { type: 'run-ended' }],
];

/** `phase/open`, `released`, or `illegal`. */
type Cell = string;

// One row per state, one column per event in the order of EVENTS.
// oxfmt-ignore
const TABLE: Record<string, Cell[]> = {
  'unlocked/none':     ['building/none',     'serving/none',     'unlocked/none',     'unlocked/none',     'unlocked/none',     'unlocked/running', 'illegal',           'unlocked/none',     'released'],
  'unlocked/running':  ['building/running',  'serving/running',  'unlocked/running',  'unlocked/running',  'unlocked/running',  'illegal',          'unlocked/returned', 'unlocked/running',  'released'],
  'unlocked/returned': ['building/returned', 'serving/returned', 'unlocked/returned', 'unlocked/returned', 'unlocked/returned', 'illegal',          'illegal',           'unlocked/returned', 'released'],
  'building/none':     ['building/none',     'serving/none',     'unlocked/none',     'building/none',     'serving/none',      'building/running', 'illegal',           'building/none',     'released'],
  'building/running':  ['building/running',  'serving/running',  'unlocked/running',  'building/running',  'serving/running',   'illegal',          'building/returned', 'finishing/running', 'released'],
  'building/returned': ['building/returned', 'serving/returned', 'unlocked/returned', 'building/returned', 'serving/returned',  'illegal',          'illegal',           'released',          'released'],
  'serving/none':      ['building/none',     'serving/none',     'unlocked/none',     'serving/none',      'serving/none',      'serving/running',  'illegal',           'serving/none',      'released'],
  'serving/running':   ['building/running',  'serving/running',  'unlocked/running',  'serving/running',   'serving/running',   'illegal',          'serving/returned',  'finishing/running', 'released'],
  'serving/returned':  ['building/returned', 'serving/returned', 'unlocked/returned', 'serving/returned',  'serving/returned',  'illegal',          'illegal',           'released',          'released'],
  'finishing/running': ['illegal',           'illegal',          'illegal',           'finishing/running', 'finishing/running', 'illegal',          'released',          'illegal',           'released'],
  released:            ['illegal',           'illegal',          'released',          'released',          'released',          'released',         'released',          'released',          'released'],
};

function parse(cell: Cell): RunState {
  if (cell === 'released') return { phase: 'released' };
  const [phase, open] = cell.split('/') as [RunState['phase'], OpenState];
  return { phase, open } as RunState;
}

const CASES = Object.entries(TABLE).flatMap(([state, row]) =>
  EVENTS.map(([name, event], column) => ({ state, name, event, expected: row[column]! }))
);

describe(nextRunState, () => {
  it.each(CASES)(`$state × $name → $expected`, ({ state, event, expected }) => {
    expect(nextRunState(parse(state), event)).toEqual(
      expected === 'illegal' ? { illegal: true } : { state: parse(expected) }
    );
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §Dev-server lock
// What each phase of this project's running dev run means to a command that would start another.
// Every reader takes its words and its next command from this table.

import { PROGRAM_PREFIX } from '../programName';
import type { RunningDevServerPhase } from '../project/types';

/** Where the run is, as a reader names it. `pid` is left out where the reader does not know it. */
export type RunAt = { port: number; pid?: number };

export interface RunPhase {
  /** The clause that names the run, e.g. `This project's dev server is starting on port 8081`. */
  state(at: RunAt): string;
  /** What a second run would start: "the run stops instead of starting a second …". */
  second: 'one' | 'session';
  /** The plan's `Dev server:` row, after `port <n>`. */
  portState: string;
  /** The next command. `smoke` is the smoke command for the caller's platform. */
  command(smoke: string): string;
  /** What {@link command} does, said after the state. */
  does: string;
  /** The `Why:` line of the refusal. */
  why(at: RunAt): string;
  /** The `How:` line of the refusal. */
  how(commands: { smoke: string; navigate: string }): string;
}

const pidOf = ({ pid }: RunAt) => (pid == null ? '' : ` (pid ${pid})`);
const stopAndRetry = `or stop it with "${PROGRAM_PREFIX} dev:stop" and run this command again.`;

export const RUN_PHASE: Record<RunningDevServerPhase, RunPhase> = {
  building: {
    state: (at) =>
      `This project's dev run${pidOf(at)} is building before it serves on port ${at.port}`,
    second: 'one',
    portState: ', building before it serves',
    command: () => `${PROGRAM_PREFIX} dev:logs`,
    does: `This shows the build; "${PROGRAM_PREFIX} dev:stop" stops it.`,
    why: () =>
      'one project has one dev run. Its lock says that it builds, and it starts its dev server when the build ends.',
    how: () =>
      `wait for it ("${PROGRAM_PREFIX} dev:logs" shows the build, "${PROGRAM_PREFIX} status" says when it serves), ${stopAndRetry}`,
  },
  serving: {
    state: (at) => `This project's dev server is already running on port ${at.port}${pidOf(at)}`,
    second: 'one',
    portState: ', already running',
    command: (smoke) => smoke,
    does: `This checks its bundle and its app; "${PROGRAM_PREFIX} dev:stop" stops it.`,
    why: () =>
      `one project has one dev server. A second one could not hold this project's lock, so "${PROGRAM_PREFIX} status" and "${PROGRAM_PREFIX} dev:stop" could not see it.`,
    how: ({ smoke, navigate }) =>
      `use the running server ("${smoke}" checks its bundle and its app, "${navigate}" opens a route), ${stopAndRetry}`,
  },
  starting: {
    state: (at) => `This project's dev server is starting on port ${at.port}${pidOf(at)}`,
    second: 'one',
    portState: ', still starting',
    command: () => `${PROGRAM_PREFIX} status`,
    does: `This says when it answers; "${PROGRAM_PREFIX} dev:stop" stops it.`,
    why: ({ port }) =>
      `its lock is published, and /status on port ${port} does not answer for this project yet: a Metro that is not up, or another project's Metro on that port, which this project's server moves off.`,
    how: () => `wait for it ("${PROGRAM_PREFIX} status" says when it answers), ${stopAndRetry}`,
  },
  finishing: {
    state: (at) => `This project's last dev run${pidOf(at)} is finishing its EAS session start`,
    second: 'session',
    portState: ', finishing its EAS session start',
    command: () => `${PROGRAM_PREFIX} dev:stop --eas`,
    does: 'This waits for that start and stops the session.',
    why: () =>
      'its dev server exited, and it binds the session its start returns to this worktree. A second run now would start a second session.',
    how: () =>
      `run "${PROGRAM_PREFIX} dev:stop --eas", which waits for that start and stops the session, then run this command again. Or wait until "${PROGRAM_PREFIX} status" shows no dev run.`,
  },
};

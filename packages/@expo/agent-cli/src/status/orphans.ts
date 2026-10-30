// What `status` reports about dev servers and EAS sessions whose owner is gone.

import { cloudStopCommand } from '../deviceBinding/cleanup';
import { deletedWorktreeSessions } from '../deviceBinding/reap';
import type { BindingSummary } from '../deviceBinding/summary';
import { PROGRAM_PREFIX } from '../programName';
import type { NextActionStatus, OrphanSessionStatus, StatusReport } from './types';

// @ref llp/0035-one-device-per-worktree.rfc.md §Session cleanup
export function readOrphanSessions(
  projectRoot: string,
  { ownServer }: { ownServer: boolean }
): OrphanSessionStatus[] {
  return deletedWorktreeSessions(projectRoot, new Date()).map(({ device, projectRoot: root }) => ({
    platform: device.platform,
    id: device.id,
    projectRoot: root,
    command: ownServer ? cloudStopCommand(device.id) : `${PROGRAM_PREFIX} dev:stop`,
  }));
}

/**
 * The `next` for this project's dev server with no lock beside a live `started` cloud binding: the
 * run that started both ended. Null otherwise.
 *
 * @ref llp/0004-smart-start-and-project-state.rfc.md §Daemonization
 */
export function endedRunNext(
  report: StatusReport,
  { cloud, platform, ownServer, devNext }: EndedRunInput
): NextActionStatus | null {
  if (ownServer || !report.devServer?.running || report.devServer.projectRootMatched !== true) {
    return null;
  }
  const session =
    cloud.find((entry) => entry.origin === 'started' && entry.platform === platform) ??
    cloud.find((entry) => entry.origin === 'started');
  if (session == null) return null;
  return {
    ...devNext,
    command: `${PROGRAM_PREFIX} dev:stop --eas`,
    why: `the run that started this dev server and EAS session ${session.id} ended; this stops both`,
  };
}

interface EndedRunInput {
  cloud: BindingSummary[];
  platform: string;
  ownServer: boolean;
  devNext: NextActionStatus;
}

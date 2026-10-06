// @ref llp/0009-smart-followups.rfc.md §Examples per command — `new`.
// The one command whose follow-ups do not run where it ran: the project it created is a directory
// away, so every command here carries the `cd` that makes it pasteable.

import type { InstallState } from '../new/install';
import { PROGRAM_PREFIX } from '../programName';
import { devCommand, hostPlatform } from '../smoke/suggest';
import { capFollowUps, type FollowUp } from './types';

export interface NewFollowUpInput {
  /** Directory as typed on the command line, so the printed commands match what was run. */
  directory: string;
  /** What is on disk: installed, skipped by `--no-install`, or asked for and missing. */
  install: InstallState;
  /** The install command for the project's package manager. Defaults to `npm install`. */
  installCommand?: string;
}

/** What to do with a project that exists but has never run. */
export function buildNewFollowUps({
  directory,
  install,
  installCommand = 'npm install',
}: NewFollowUpInput): FollowUp[] {
  const followups: FollowUp[] = [];
  const inProject = (command: string) => `cd ${directory} && ${command}`;

  if (install !== 'installed') {
    // Nothing else on this list can work before `node_modules` exists, so it goes first.
    followups.push({
      id: 'install-dependencies',
      command: inProject(installCommand),
      why:
        install === 'skipped'
          ? '--no-install skipped the dependency install, so nothing in the project can run yet.'
          : 'create-expo exited 0 but its dependency install did not finish, so nothing in the project can run yet.',
    });
  }

  followups.push(
    {
      id: 'status',
      command: inProject(`${PROGRAM_PREFIX} status`),
      why: 'Prints what the new project is and what would happen next, without starting anything.',
    },
    {
      id: 'dev',
      command: inProject(devCommand(hostPlatform())),
      why: 'Runs the app, deciding between Expo Go, a development build and a plain dev server from the project state.',
    },
    {
      id: 'agents-setup',
      command: inProject(`${PROGRAM_PREFIX} agents:setup`),
      why: 'Links the agent skills of the installed packages and writes the managed AGENTS.md block.',
    }
  );

  return capFollowUps(followups);
}

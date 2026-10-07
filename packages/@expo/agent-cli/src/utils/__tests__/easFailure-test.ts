// @ref llp/0021-honest-reports.rfc.md §The rules
// The 2026-08-26 live run's S2 and friction run 7's F67: the upload was diagnosed from its exit
// signature, so an unlinked project was told it was not signed in while the real cause sat in the
// raw output.

import { classifyEasFailure, easFailureReason, readEasFailure } from '../easFailure';

/** The whole of what an unlinked project's `eas deploy` prints [observed — friction run 9]. */
const UNLINKED_OUTPUT = [
  'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:',
  '',
  'To link an existing project:',
  '',
  '  eas init --id <project-id> --non-interactive',
  '',
  'To create a new project:',
  '',
  '  eas init --account <account-name> --non-interactive',
  '',
  'Accounts you can create projects in: alice, expo, expo-services, bob',
  '    Error: deploy command failed.',
].join('\n');

describe(classifyEasFailure, () => {
  // The whole finding: this output is what an unlinked project produces, and "not signed in" is
  // what the old single `Why:` line said about it.
  it(`should read an unlinked project, and name eas init`, () => {
    const cause = classifyEasFailure(
      [
        'EAS project not configured.',
        'Run "eas init" to configure this project, or "eas init --id <id>" to link an existing one.',
        'Error: deploy command failed.',
      ].join('\n')
    );

    expect(cause?.command).toContain('npx --yes eas-cli@latest init');
    expect(cause?.why).toContain('not linked');
    // The sentence has to rule the wrong answer out, because that is the answer it replaces.
    expect(cause?.why).toContain('not about being signed in');
  });

  // @ref llp/0007-deploy-and-headless.rfc.md §deploy — **F143.** `npx --yes eas-cli@latest init` on
  // its own is a command that prompts, and this failure exists because the run had no terminal to
  // prompt in: handing it back is handing back the same dead end one command earlier. The runnable
  // form needs a value, and the EAS CLI's own output is where that value is.
  it(`should name the non-interactive form of the fix`, () => {
    const cause = classifyEasFailure(UNLINKED_OUTPUT);

    expect(cause?.command).toBe(
      'npx --yes eas-cli@latest init --account <account-name> --non-interactive'
    );
    // Both forms in the How:, because linking an existing project and creating a new one are
    // different intentions and only the caller knows which one they have.
    expect(cause?.how).toContain('--id <project-id> --non-interactive');
    expect(cause?.how).toContain('--account');
  });

  // The accounts are the one value this CLI cannot invent, and the tool printed them.
  it(`should quote the accounts the EAS CLI listed`, () => {
    expect(classifyEasFailure(UNLINKED_OUTPUT)?.how).toContain('alice, expo, expo-services, bob');
  });

  // With one account there is no choice to make, so the line has no hole in it and an agent can run
  // it — which is the difference between a handoff and a next action.
  it(`should fill the account in when the EAS CLI named exactly one`, () => {
    const cause = classifyEasFailure(
      ['EAS project not configured.', 'Accounts you can create projects in: bob'].join('\n')
    );

    expect(cause?.command).toBe('npx --yes eas-cli@latest init --account bob --non-interactive');
  });

  it.each([
    ['You are not logged in. Run "eas login".'],
    ['Error: Not logged in'],
    ['An Expo user account is required. Must be logged in.'],
  ])(`should read a signed-out machine from %p`, (output) => {
    expect(classifyEasFailure(output)?.command).toBe('npx @expo/agent-cli login');
  });

  // Nothing recognised is not a licence to guess: the caller says so instead.
  it(`should answer null for output it does not recognise`, () => {
    expect(classifyEasFailure('Error: deploy command failed.')).toBeNull();
  });

  it(`should answer null for empty output`, () => {
    expect(classifyEasFailure('')).toBeNull();
  });
});

// @ref llp/0027-everything-on-eas.rfc.md §What EAS said
describe('the one-line summary', () => {
  it(`names the fix for an unlinked project, with the account when there is one`, () => {
    const summary = classifyEasFailure(
      ['EAS project not configured.', 'Accounts you can create projects in: bob'].join('\n')
    )?.summary;
    expect(summary).toContain('not linked to an EAS project');
    expect(summary).toContain('npx --yes eas-cli@latest init --account bob --non-interactive');
  });

  it(`leaves the account a hole when several could be meant`, () => {
    expect(classifyEasFailure(UNLINKED_OUTPUT)?.summary).toContain('--account <account-name>');
  });

  it(`names the login for a signed-out machine`, () => {
    expect(classifyEasFailure('You are not logged in')?.summary).toContain(
      'npx @expo/agent-cli login'
    );
  });
});

// @ref llp/0021-honest-reports.rfc.md §The rules — rules 11 and 14. On a cold scratch directory bunx
// writes its install progress to stderr before the EAS CLI writes there [observed — 2026-10-05].
describe(readEasFailure, () => {
  const RUNNER =
    'Resolving dependencies\nResolved, downloaded and extracted [214]\nSaved lockfile\n';

  it.each([
    [
      'the first line after the runner',
      `${RUNNER}TypeError: x is not a function\n`,
      '',
      { kind: 'line', line: 'TypeError: x is not a function' },
    ],
    [
      'stdout when stderr is only the runner',
      RUNNER,
      'Error: build not found',
      { kind: 'line', line: 'Error: build not found' },
    ],
    [
      'the runner when it printed everything',
      RUNNER,
      '',
      { kind: 'runner-only', runnerLine: 'Resolving dependencies' },
    ],
    [
      'stdout before the closing line',
      'Error: build:list command failed.\n',
      'Something this CLI does not recognise.',
      { kind: 'line', line: 'Something this CLI does not recognise.' },
    ],
    [
      'the closing line when nothing else was printed',
      'Error: build:list command failed.\n',
      '',
      { kind: 'line', line: 'Error: build:list command failed.' },
    ],
    [
      'stderr before stdout',
      'Error: quota exceeded\n',
      'Simulator session created (id: s1)',
      { kind: 'line', line: 'Error: quota exceeded' },
    ],
    ['nothing when nothing was printed', '', '  \n', { kind: 'nothing' }],
  ])('reads %s', (_, stderr, stdout, expected) => {
    expect(readEasFailure({ stdout, stderr })).toEqual(expected);
  });

  it('reads a recognised sentence after the runner', () => {
    const said = readEasFailure({ stdout: '', stderr: `${RUNNER}Error: You are not logged in.\n` });
    expect(said.kind === 'cause' && said.cause.id).toBe('eas-login');
  });
});

describe(easFailureReason, () => {
  const invocation = 'bunx eas-cli@latest simulator:start';

  it('quotes what EAS said', () => {
    expect(
      easFailureReason(
        { exitCode: 1, stdout: '', stderr: 'Resolving dependencies\nError: quota exceeded\n' },
        invocation
      )
    ).toBe('"bunx eas-cli@latest simulator:start" exited 1: Error: quota exceeded');
  });

  it('says the runner did not deliver the CLI when only the runner printed', () => {
    const reason = easFailureReason(
      { exitCode: 1, stdout: '', stderr: 'Resolving dependencies\n' },
      invocation
    );
    expect(reason).toContain('failed to deliver the eas CLI');
    expect(reason).toContain('("Resolving dependencies")');
  });

  it('says a run that printed nothing printed nothing', () => {
    expect(easFailureReason({ exitCode: null, stdout: '', stderr: '' }, invocation)).toBe(
      '"bunx eas-cli@latest simulator:start" exited on a signal: it printed nothing'
    );
  });
});

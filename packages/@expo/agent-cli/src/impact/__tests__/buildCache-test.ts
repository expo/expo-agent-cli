import { describeLookupFailure } from '../buildCache';

/** How the invocation is written when it has to be named, per `easCliLabel`. */
const INVOCATION = 'bunx eas-cli@latest';

describe(describeLookupFailure, () => {
  // @ref llp/0027-everything-on-eas.rfc.md §What EAS said
  it('answers an unlinked project in its own words, with the eas init that links it', () => {
    // The shape a real refusal takes [observed — live against an unlinked project, 2026-08-26]:
    // the explanation on stdout, one sentence on stderr. The first line of that explanation ends
    // in "Run one of the following, then re-run this command:" and a reason that quoted it lost the
    // following [observed — `status --explain`, 2026-09-08].
    const reason = describeLookupFailure(
      {
        exitCode: 1,
        stdout:
          'EAS project not configured. This command cannot configure it in non-interactive mode. Run one of the following, then re-run this command:\n\n  eas init --account <account-name> --non-interactive\n\nAccounts you can create projects in: bob\n',
        stderr: 'Error: build:list command failed.\n',
      },
      INVOCATION
    );
    expect(reason).toContain('not linked to an EAS project');
    expect(reason).toContain('npx --yes eas-cli@latest init --account bob --non-interactive');
    expect(reason).not.toContain('Run one of the following');
  });

  it('quotes the explanation the CLI put on stdout, not the one sentence on stderr', () => {
    expect(
      describeLookupFailure(
        {
          exitCode: 1,
          stdout: 'Something this CLI does not recognise.\nMore about it.\n',
          stderr: 'Error: build:list command failed.\n',
        },
        INVOCATION
      )
    ).toBe('Something this CLI does not recognise.');
  });

  it('falls back to stderr when the CLI said nothing on stdout', () => {
    expect(
      describeLookupFailure(
        { exitCode: 1, stdout: '', stderr: 'Entity not authorized: Build (ID 123)\n' },
        INVOCATION
      )
    ).toBe('Entity not authorized: Build (ID 123)');
  });

  it('says so when the lookup ran and printed nothing at all', () => {
    expect(describeLookupFailure({ exitCode: 1, stdout: '', stderr: '' }, INVOCATION)).toBe(
      'the EAS CLI refused the lookup and printed nothing'
    );
  });

  // F93 — the one line this function may never return. `status` prints what comes back here as what
  // EAS answered about the caller's builds, and this is bun installing [observed — live, 2026-08-27,
  // six runs of `status --explain`: `reason: "Resolving dependencies"` on 3 of them].
  it("never reports the package runner's progress as the service's answer", () => {
    const reason = describeLookupFailure(
      {
        exitCode: 1,
        stdout: '',
        stderr: 'Resolving dependencies\nResolved, downloaded and extracted [214]\n',
      },
      INVOCATION
    );

    expect(reason).not.toBe('Resolving dependencies');
    expect(reason).toContain('failed to deliver the eas CLI');
    expect(reason).toContain(INVOCATION);
    // The runner's line is still shown, as the runner's: a reader who wants to know what happened
    // can see it without being told it is a fact about their account.
    expect(reason).toContain('"Resolving dependencies"');
  });

  it("keeps a real refusal's own words even when the runner also spoke", () => {
    // The common successful-install shape: bun's progress on stderr and the CLI's answer on stdout.
    // Anything on stdout is an answer, so the guard must stand down.
    expect(
      describeLookupFailure(
        {
          exitCode: 1,
          stdout: 'EAS project not configured.\n',
          stderr: 'Resolving dependencies\nError: build:list command failed.\n',
        },
        INVOCATION
      )
    ).toContain('not linked to an EAS project');
  });
});

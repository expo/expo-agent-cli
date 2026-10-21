// @ref llp/0015-backend-selection-and-config.rfc.md §The device backend
import {
  argvPassesLocal,
  setRunBackendFlag,
  withRunBackendFlag,
  withRunBackendFlagDeep,
} from '../backendFlag';

const local = (text: string) => withRunBackendFlag(text, '--local');

describe('Adding --local to printed device commands', () => {
  afterEach(() => setRunBackendFlag(null));

  it('should append --local to a device command', () => {
    expect(local('npx @expo/agent-cli dev --ios --detach --wait-ready')).toBe(
      'npx @expo/agent-cli dev --ios --detach --wait-ready --local'
    );
    expect(local('npx @expo/agent-cli dev:stop')).toBe('npx @expo/agent-cli dev:stop --local');
  });

  it('should rewrite every device command in a How line, and stop at the quote', () => {
    expect(
      local(
        'How: run "npx @expo/agent-cli navigate / --ios", then "npx @expo/agent-cli smoke --ios".'
      )
    ).toBe(
      'How: run "npx @expo/agent-cli navigate / --ios --local", then "npx @expo/agent-cli smoke --ios --local".'
    );
  });

  it('should rewrite both halves of an && line', () => {
    expect(
      local('npx @expo/agent-cli dev:stop && npx @expo/agent-cli dev --android --detach')
    ).toBe(
      'npx @expo/agent-cli dev:stop --local && npx @expo/agent-cli dev --android --detach --local'
    );
  });

  it('should put the flag before a full stop that ends the sentence', () => {
    expect(local('Run npx @expo/agent-cli runtime:reload --ios.')).toBe(
      'Run npx @expo/agent-cli runtime:reload --ios --local.'
    );
  });

  it('should keep a JSON-escaped quote intact', () => {
    expect(local('"How: run \\"npx @expo/agent-cli dev --ios\\" again"')).toBe(
      '"How: run \\"npx @expo/agent-cli dev --ios --local\\" again"'
    );
  });

  it('should leave a command that already names a backend', () => {
    expect(local('npx @expo/agent-cli navigate / --ios --local')).toBe(
      'npx @expo/agent-cli navigate / --ios --local'
    );
    expect(local('npx @expo/agent-cli dev:stop --eas')).toBe('npx @expo/agent-cli dev:stop --eas');
  });

  it('should leave commands that do not read deviceBackend', () => {
    for (const command of [
      'npx @expo/agent-cli dev:logs',
      'npx @expo/agent-cli runtime:errors --ios',
      'npx @expo/agent-cli status --json',
    ]) {
      expect(local(command)).toBe(command);
    }
  });

  it('should not move arguments after a lone --', () => {
    expect(local('npx @expo/agent-cli dev --ios -- --clear')).toBe(
      'npx @expo/agent-cli dev --ios --local -- --clear'
    );
  });

  it('should change nothing for a run that did not pass --local', () => {
    expect(withRunBackendFlag('npx @expo/agent-cli dev --ios', null)).toBe(
      'npx @expo/agent-cli dev --ios'
    );
  });

  it('should rewrite the strings of an event payload and nothing else', () => {
    expect(
      withRunBackendFlagDeep(
        { followups: [{ command: 'npx @expo/agent-cli smoke --ios', rank: 1 }], ok: true },
        '--local'
      )
    ).toEqual({
      followups: [{ command: 'npx @expo/agent-cli smoke --ios --local', rank: 1 }],
      ok: true,
    });
  });

  it('should read --local only before --', () => {
    expect(argvPassesLocal(['--ios', '--local'])).toBe(true);
    expect(argvPassesLocal(['--ios', '--', '--local'])).toBe(false);
  });
});

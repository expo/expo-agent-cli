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

  it('should match the bunx spelling as well', () => {
    expect(local('Try: bunx @expo/agent-cli navigate / --ios')).toBe(
      'Try: bunx @expo/agent-cli navigate / --ios --local'
    );
  });

  it('should read a single-quoted word as one argument', () => {
    expect(local("npx @expo/agent-cli dev --ios --device 'iPhone 16' --detach --wait-ready")).toBe(
      "npx @expo/agent-cli dev --ios --device 'iPhone 16' --detach --wait-ready --local"
    );
    const flagged = "npx @expo/agent-cli dev --ios --device 'iPhone 16' --local --detach";
    expect(local(flagged)).toBe(flagged);
    const eas = "npx @expo/agent-cli navigate '/a b' --eas";
    expect(local(eas)).toBe(eas);
    expect(local(`run "npx @expo/agent-cli dev --ios --device 'iPhone 16'" again`)).toBe(
      `run "npx @expo/agent-cli dev --ios --device 'iPhone 16' --local" again`
    );
  });

  it('should match the bare name the plan reasons use', () => {
    expect(local('Open it with "@expo/agent-cli navigate /" once a device is up.')).toBe(
      'Open it with "@expo/agent-cli navigate / --local" once a device is up.'
    );
  });

  it('should not match the name inside a path or a version spec', () => {
    for (const text of [
      'node_modules/@expo/agent-cli dev --ios',
      'npx @expo/agent-cli@1.0.20 dev --ios',
    ]) {
      expect(local(text)).toBe(text);
    }
  });

  it('should change nothing on a second pass, before a colour reset or a full stop', () => {
    const colored = `\x1b[36mnpx @expo/agent-cli smoke --ios\x1b[39m`;
    const once = local(colored);
    expect(once).toBe(`\x1b[36mnpx @expo/agent-cli smoke --ios --local\x1b[39m`);
    expect(local(once)).toBe(once);
    const sentence = local('Run npx @expo/agent-cli runtime:reload --ios.');
    expect(local(sentence)).toBe(sentence);
    expect(local('\x1b[36mnpx @expo/agent-cli navigate / --eas\x1b[39m')).toBe(
      '\x1b[36mnpx @expo/agent-cli navigate / --eas\x1b[39m'
    );
  });

  it('should still add --local beside --localhost', () => {
    expect(local('npx @expo/agent-cli dev --ios --localhost')).toBe(
      'npx @expo/agent-cli dev --ios --localhost --local'
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

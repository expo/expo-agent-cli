import { stripVTControlCharacters } from 'node:util';

import type { StartPlan } from '../../project/types';
import type { PlanBuildLocation } from '../../toolchain/types';
import { formatBuildLocation, formatStartPlan, formatTimeClass } from '../format';

/** One line without color, so assertions never depend on the terminal's color support. */
function strip(line: string): string {
  return stripVTControlCharacters(line);
}

const plan: StartPlan = {
  target: 'dev-client',
  rule: 'dev-client-stale',
  reasons: ['Expo SDK 54.0.0.', 'expo-dev-client is a dependency.'],
  steps: [
    {
      id: 'prebuild',
      argv: ['expo', 'prebuild', '--platform', 'ios'],
      reason: 'Generates the ios project from the app config.',
      timeClass: 'a-minute',
      runsOn: 'local',
    },
    {
      id: 'run',
      argv: ['expo', 'run:ios'],
      reason: 'Builds, installs, and starts the dev server.',
      timeClass: 'many-minutes',
      runsOn: 'local',
    },
  ],
  buildLocation: {
    runsOn: 'local',
    platform: 'ios',
    requirement: 'Xcode on this machine',
    status: 'present',
    detail: 'Xcode 16.2 at /Applications/Xcode.app/Contents/Developer.',
    caveats: [],
    selection: null,
    alternativeCommand: 'npx --yes eas-cli@latest build --platform ios --profile development',
  },
};

describe(formatTimeClass, () => {
  it(`should label every time class`, () => {
    expect(formatTimeClass('seconds')).toBe('~seconds');
    expect(formatTimeClass('a-minute')).toBe('~a minute');
    expect(formatTimeClass('minutes')).toBe('~a few minutes');
    expect(formatTimeClass('many-minutes')).toBe('~many minutes');
  });
});

describe(formatStartPlan, () => {
  it(`should report the rule and the target`, () => {
    expect(formatStartPlan(plan)).toMatch(/dev-client-stale/);
    expect(formatStartPlan(plan)).toMatch(/target: dev-client/);
  });

  it(`should list every step with its command, cost, and reason`, () => {
    const output = formatStartPlan(plan);

    expect(output).toMatch(/1\. expo prebuild --platform ios/);
    expect(output).toMatch(/2\. expo run:ios/);
    expect(output).toMatch(/~a minute/);
    expect(output).toMatch(/~many minutes/);
    expect(output).toMatch(/Generates the ios project from the app config\./);
    expect(output).toMatch(/Builds, installs, and starts the dev server\./);
  });

  it(`should list every reason`, () => {
    const output = formatStartPlan(plan);

    for (const reason of plan.reasons) {
      expect(output).toContain(reason);
    }
  });

  it.each<[NonNullable<StartPlan['devServerPort']>, string]>([
    [{ port: 8081, movedFrom: null, state: 'picked' }, 'Dev server: port 8081.'],
    [
      { port: 8082, movedFrom: 8081, state: 'picked' },
      'Dev server: port 8082, because 8081 is taken.',
    ],
    [
      { port: 8180, movedFrom: null, state: 'named', taken: false },
      'Dev server: port 8180, as named.',
    ],
    [
      { port: 8180, movedFrom: null, state: 'named', taken: true },
      'Dev server: port 8180, as named, which is taken.',
    ],
    [
      { port: 8190, movedFrom: null, state: 'reused' },
      "Dev server: port 8190, where this project's dev server runs; the plan starts none.",
    ],
    [
      { port: 8190, movedFrom: null, state: 'starting' },
      "Dev server: port 8190, where this project's dev server is still starting; the run stops.",
    ],
    [
      { port: 8190, movedFrom: null, state: 'foreign' },
      'Dev server: port 8190, which answers for another project; the run stops.',
    ],
    [
      { port: 8190, movedFrom: null, state: 'mismatch', missing: ['--tunnel'], extra: [] },
      "Dev server: port 8190, where this project's dev server runs without --tunnel; the run stops.",
    ],
    [
      {
        port: 8190,
        movedFrom: null,
        state: 'mismatch',
        missing: ['--tunnel'],
        extra: ['--no-dev'],
      },
      "Dev server: port 8190, where this project's dev server runs without --tunnel and with --no-dev; the run stops.",
    ],
    [
      { port: 8190, movedFrom: null, state: 'mismatch', missing: ['--tunnel'], extra: null },
      "Dev server: port 8190, where this project's dev server runs with unknown options; the run stops.",
    ],
    [
      { port: 8081, movedFrom: null, state: 'elsewhere', running: 8190 },
      "Dev server: port 8081, while this project's dev server runs on 8190; the run stops.",
    ],
  ])(`should name the dev server's port and its state: %o`, (devServerPort, line) => {
    expect(strip(formatStartPlan({ ...plan, devServerPort }))).toContain(line);
  });

  it(`should print no dev server row for a plan without a port`, () => {
    expect(strip(formatStartPlan(plan))).not.toContain('Dev server:');
  });

  it(`should say a plan with no steps runs nothing`, () => {
    expect(strip(formatStartPlan({ ...plan, steps: [] }))).toContain('No steps: nothing runs.');
  });

  it(`should say a reuse plan with no steps reuses the running dev server`, () => {
    const devServerPort = { port: 8190, movedFrom: null, state: 'reused' } as const;
    expect(strip(formatStartPlan({ ...plan, steps: [], devServerPort }))).toContain(
      'No steps: the running dev server is reused.'
    );
  });

  it(`should format a plan of one step`, () => {
    const output = formatStartPlan({
      ...plan,
      rule: 'expo-go',
      target: 'expo-go',
      buildLocation: null,
      steps: [
        {
          id: 'start',
          argv: ['expo', 'start', '--go'],
          reason: 'Opens in Expo Go.',
          timeClass: 'seconds',
          runsOn: null,
        },
      ],
    });

    expect(output).toMatch(/1\. expo start --go/);
    expect(output).not.toMatch(/2\./);
  });

  // @ref llp/0004-smart-start-and-project-state.rfc.md §Where a build runs
  describe('where the build runs', () => {
    it(`should mark every building step, and only those`, () => {
      const output = formatStartPlan(plan);

      expect(output).toMatch(/expo prebuild --platform ios\s+~a minute\s+local/);
      expect(output).toMatch(/expo run:ios\s+~many minutes\s+local/);
    });

    it(`should label no step of a plan that builds nothing`, () => {
      const output = formatStartPlan({
        ...plan,
        buildLocation: null,
        steps: [
          {
            id: 'start',
            argv: ['expo', 'start', '--go'],
            reason: 'Opens in Expo Go.',
            timeClass: 'seconds',
            runsOn: null,
          },
        ],
      });

      expect(output).not.toContain('local');
      expect(output).not.toContain('Build:');
    });

    it(`should say where the build happens and that this machine can do it`, () => {
      const output = formatStartPlan(plan);

      expect(output).toContain('Build: local — runs on this machine, needs Xcode on this machine.');
      expect(output).toContain('Found: Xcode 16.2');
    });

    // The point of the whole line: a caller who cannot build here learns it here, and the command
    // that does work is on the same line as the problem.
    it(`should name the EAS command when this machine cannot build`, () => {
      const output = formatStartPlan({
        ...plan,
        buildLocation: {
          ...plan.buildLocation!,
          status: 'missing',
          detail: 'xcode-select is not on PATH.',
        },
      });

      expect(output).toContain('Not found: xcode-select is not on PATH.');
      expect(output).toContain(
        'Instead: npx --yes eas-cli@latest build --platform ios --profile development'
      );
    });

    it(`should not call an unprobeable machine a machine without the toolchain`, () => {
      const output = formatStartPlan({
        ...plan,
        buildLocation: {
          ...plan.buildLocation!,
          status: 'unknown',
          detail: 'The ios toolchain could not be probed: EPERM',
        },
      });

      expect(output).toContain('Not established');
      expect(output).not.toContain('Not found');
      expect(output).toContain(
        'If it is missing: npx --yes eas-cli@latest build --platform ios --profile development'
      );
    });
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The selection
describe('the Build line of a plan whose backend was chosen', () => {
  function locationWith(overrides: Partial<PlanBuildLocation>): PlanBuildLocation {
    return {
      runsOn: 'local',
      platform: 'ios',
      requirement: 'Xcode on this machine',
      status: null,
      detail: null,
      caveats: [],
      alternativeCommand: 'npx --yes eas-cli@latest build --platform ios --profile development',
      selection: null,
      ...overrides,
    };
  }

  function selection(overrides: Partial<NonNullable<PlanBuildLocation['selection']>> = {}) {
    return {
      runsOn: 'local' as const,
      source: 'default' as const,
      because: 'this machine has Xcode.',
      why: 'Building on this machine: this machine has Xcode.',
      doomed: false,
      implicit: false,
      ...overrides,
    };
  }

  it(`says the cause without repeating the place`, () => {
    const line = strip(formatBuildLocation(locationWith({ selection: selection() })));

    expect(line).toContain('Build: local — runs on this machine');
    expect(line).toContain('Chosen because this machine has Xcode.');
    // The head already said where; the full sentence would say it a second time.
    expect(line).not.toContain('Building on this machine');
  });

  it(`says a chosen local build cannot happen here, and what does work`, () => {
    const line = strip(
      formatBuildLocation(
        locationWith({
          status: 'missing',
          detail: 'xcode-select is not on PATH.',
          selection: selection({ source: 'flag', because: '--local was passed.' }),
        })
      )
    );

    expect(line).toContain('Chosen because --local was passed.');
    expect(line).toContain('Not found: xcode-select is not on PATH.');
    expect(line).toContain(
      'Instead: npx --yes eas-cli@latest build --platform ios --profile development'
    );
  });

  it(`names the cloud and what it needs`, () => {
    const line = strip(
      formatBuildLocation(
        locationWith({
          runsOn: 'eas',
          requirement: 'an Expo account',
          alternativeCommand: 'npx expo run:ios',
          selection: selection({
            runsOn: 'eas',
            source: 'host',
            because: 'this host runs linux.',
          }),
        })
      )
    );

    expect(line).toContain('Build: eas — runs in the cloud on EAS, needs an Expo account.');
    expect(line).toContain('Chosen because this host runs linux.');
  });
});

// @ref llp/0015-backend-selection-and-config.rfc.md §The plan approved is the plan run
// Friction run 7's F71 and the 2026-08-26 live run's S5: `dev --plan --tunnel` printed a command
// that was not the command the run executed.

import type { PlanStep, StartPlan } from '../../project/types';
import {
  forwardedStepArgs,
  withDevice,
  withDevServerPort,
  withForwardedExpoArgs,
  withoutPortArgs,
  withPortArg,
} from '../forwardedArgs';

function step(id: string, argv: string[]): PlanStep {
  return { id, argv, reason: 'because', timeClass: 'seconds', runsOn: null };
}

function plan(...steps: PlanStep[]): StartPlan {
  return { target: 'expo-go', steps, rule: 'test', reasons: [], buildLocation: null };
}

describe(forwardedStepArgs, () => {
  it(`should add the caller's options to the expo start step`, () => {
    expect(
      forwardedStepArgs(step('start', ['expo', 'start', '--go']), ['--tunnel'], { isLast: true })
    ).toEqual({ args: ['start', '--go', '--tunnel'], dropped: [] });
  });

  // The plan already sets the flags it needs, and a flag twice on one command line is a command
  // nobody wrote.
  it(`should not add a flag the plan already sets`, () => {
    expect(
      forwardedStepArgs(step('start', ['expo', 'start', '--go']), ['--go', '--tunnel'], {
        isLast: true,
      }).args
    ).toEqual(['start', '--go', '--tunnel']);
  });

  it(`should leave an earlier step alone`, () => {
    expect(
      forwardedStepArgs(step('prebuild', ['expo', 'prebuild']), ['--tunnel'], { isLast: false })
    ).toEqual({ args: ['prebuild'], dropped: [] });
  });

  // A plan that ends in `expo run:*` has nothing to forward to, and a dropped flag has to be said
  // out loud (friction run 5, F48-3).
  it(`should report what a non-start step cannot receive`, () => {
    expect(
      forwardedStepArgs(step('run', ['expo', 'run:ios']), ['--ios', '--tunnel'], { isLast: true })
    ).toEqual({ args: ['run:ios'], dropped: ['--tunnel'] });
  });
});

describe(withForwardedExpoArgs, () => {
  it(`should carry the forwarded flags on the plan itself`, () => {
    const result = withForwardedExpoArgs(
      plan(step('prebuild', ['expo', 'prebuild']), step('start', ['expo', 'start', '--go'])),
      ['--tunnel', '--port', '8190']
    );

    expect(result.plan.steps.map((one) => one.argv)).toEqual([
      ['expo', 'prebuild'],
      ['expo', 'start', '--go', '--tunnel', '--port', '8190'],
    ]);
    expect(result.dropped).toEqual([]);
  });

  it(`should leave a plan with no forwarded flags untouched`, () => {
    const original = plan(step('start', ['expo', 'start', '--go']));

    expect(withForwardedExpoArgs(original, []).plan).toBe(original);
  });

  it(`should report the flags a run:* plan drops`, () => {
    expect(
      withForwardedExpoArgs(plan(step('run', ['expo', 'run:android'])), ['--android', '--tunnel'])
        .dropped
    ).toEqual(['--tunnel']);
  });
});

describe(withoutPortArgs, () => {
  it.each([
    [['--port', '8190', '--tunnel']],
    [['-p', '8190', '--tunnel']],
    [['--port=8190', '--tunnel']],
    [['-p=8190', '--tunnel']],
  ])(`should drop the port from %j`, (args) => {
    expect(withoutPortArgs(args)).toEqual(['--tunnel']);
  });

  it(`should keep a port after the -- separator, which is another tool's`, () => {
    expect(withoutPortArgs(['--go', '--port', '8190', '--', 'foo', '--port', '9000'])).toEqual([
      '--go',
      '--',
      'foo',
      '--port',
      '9000',
    ]);
  });
});

describe(withPortArg, () => {
  it(`should replace the port the arguments already name`, () => {
    expect(withPortArg(['start', '--go', '--port', '8081'], 8082)).toEqual([
      'start',
      '--go',
      '--port',
      '8082',
    ]);
  });

  it(`should put the port before the -- separator`, () => {
    expect(withPortArg(['--go', '--', 'foo'], 8082)).toEqual([
      '--go',
      '--port',
      '8082',
      '--',
      'foo',
    ]);
    expect(withoutPortArgs(['--go', '--', 'foo'])).toEqual(['--go', '--', 'foo']);
  });
});

// @ref llp/0004-smart-start-and-project-state.rfc.md §A busy port is not a step only a person can
// complete — every step that serves or compiles the port in gets the one the plan picked.
describe(withDevServerPort, () => {
  it(`should put the port on run:* and start, and leave the rest alone`, () => {
    const result = withDevServerPort(
      plan(
        step('prebuild', ['expo', 'prebuild', '--platform', 'ios']),
        step('run', ['expo', 'run:ios', '--device', 'UDID']),
        step('install', ['expo', 'run:android', '--no-bundler', '--device', 'emulator-5554']),
        step('eas-build', ['eas', 'build', '--platform', 'ios']),
        step('start', ['expo', 'start', '--dev-client'])
      ),
      8082
    );

    expect(result.steps.map((one) => one.argv)).toEqual([
      ['expo', 'prebuild', '--platform', 'ios'],
      ['expo', 'run:ios', '--device', 'UDID', '--port', '8082'],
      ['expo', 'run:android', '--no-bundler', '--device', 'emulator-5554'],
      ['eas', 'build', '--platform', 'ios'],
      ['expo', 'start', '--dev-client', '--port', '8082'],
    ]);
  });
});

// @ref llp/0031-ios-binding.plan.md §How `dev` uses it — withDevice-after-forwarded-args: the
// bound device replaces any `--device` a step carries, on the steps that build or install only.
describe(withDevice, () => {
  it(`should pin run and install to the device, replacing one already named`, () => {
    const result = withDevice(
      plan(
        step('prebuild', ['expo', 'prebuild', '--platform', 'ios']),
        step('run', ['expo', 'run:ios', '--device', 'OLD', '--port', '8082']),
        step('install', ['expo', 'run:ios', '--no-bundler', '--device=OLD']),
        step('start', ['expo', 'start', '--dev-client', '--device', 'OLD'])
      ),
      'SIM-1'
    );

    expect(result.steps.map((one) => one.argv)).toEqual([
      ['expo', 'prebuild', '--platform', 'ios'],
      ['expo', 'run:ios', '--port', '8082', '--device', 'SIM-1'],
      ['expo', 'run:ios', '--no-bundler', '--device', 'SIM-1'],
      ['expo', 'start', '--dev-client', '--device', 'OLD'],
    ]);
  });

  it(`should leave a plan with neither step as it is`, () => {
    const serving = plan(step('start', ['expo', 'start']));

    expect(withDevice(serving, 'SIM-1')).toEqual(serving);
  });
});

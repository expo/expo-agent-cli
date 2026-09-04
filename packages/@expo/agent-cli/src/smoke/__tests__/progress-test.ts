// @ref llp/0005-runtime-loop-tools.rfc.md §The gate says what it is doing while it does it
//
// What the gate says while it runs. Three properties are worth pinning, and they are the three the
// module was written for: nothing goes to stdout, a bound is printed only when it is real, and the
// `app` phase's two very different steps read as two different sentences.

import { buildSmokeProgress } from '../progress';
import type { SmokeOptions } from '../resolveOptions';
import * as Log from '../../log';

function options(overrides: Partial<SmokeOptions> = {}): SmokeOptions {
  return {
    route: null,
    platform: 'ios',
    cloud: 'fallback',
    bootstrap: true,
    windowMs: 3_000,
    timeoutMs: 60_000,
    screenshotPath: null,
    screenshot: true,
    devServerUrl: null,
    routeCheck: true,
    reload: true,
    json: false,
    followups: true,
    ...overrides,
  };
}

/** Everything one reporter printed, with the colouring taken off. */
function said(build: (say: ReturnType<typeof buildSmokeProgress>) => void): string[] {
  const lines: string[] = [];
  const progress = vi.spyOn(Log, 'progress').mockImplementation((...message: string[]) => {
    lines.push(message.join(' '));
  });
  try {
    build(buildSmokeProgress(options()));
  } finally {
    progress.mockRestore();
  }
  // eslint-disable-next-line no-control-regex
  return lines.map((line) => line.replace(/\[[0-9;]*m/g, ''));
}

describe(buildSmokeProgress, () => {
  // @ref llp/0006-agent-native-cli-surface.rfc.md §Output contract — `stdout` carries one object
  // and nothing else, so a progress line there would break `JSON.parse(stdout)` for every `--json`
  // caller. The one property of this module that a reader cannot see by looking at the output.
  it(`writes nothing to stdout`, () => {
    const log = vi.spyOn(Log, 'log').mockImplementation(() => {});
    const progress = vi.spyOn(Log, 'progress').mockImplementation(() => {});
    try {
      buildSmokeProgress(options())('bundle', null);
      expect(progress).toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      progress.mockRestore();
    }
  });

  it(`names the phase in the present tense, and the platform where it decides the answer`, () => {
    expect(said((say) => say('bundle', null))[0]).toContain(
      `Checking that this project's own code compiles for ios`
    );
    expect(said((say) => say('boot-device', null))[0]).toContain('Booting an ios device');
  });

  // A bound is a promise about how long the caller may have to wait, so it is printed only where
  // the walk really knows one (@ref ../progress §SmokeProgress). `null` is the walk saying it does
  // not, and a line that invented one would be worse than a line with none.
  it(`states a budget when the walk knows one, and nothing when it does not`, () => {
    expect(said((say) => say('errors', 120_000))[0]).toContain('(up to 2m)');
    expect(said((say) => say('errors', null))[0]).not.toContain('up to');
    // Minutes for a budget measured in them, seconds for one that is not: `1800.0s` for a native
    // build is a number a reader has to do arithmetic on (@ref ../progress §formatBudget).
    expect(said((say) => say('errors', 8_000))[0]).toContain('(up to 8.0s)');
  });

  // Below a few seconds a bound is not a decision anybody makes, and the sub-second probes would
  // otherwise carry one that reads as a promise about the whole phase.
  it(`leaves a budget too short to plan around unsaid`, () => {
    expect(said((say) => say('reload', 800))[0]).not.toContain('up to');
  });

  // @ref src/smoke/phases.ts, the `app` phase. Two steps of very different sizes — a two-second
  // look, then an open and a wait that is the longest thing the command does — so the phase says
  // two lines rather than one that covers neither.
  it(`tells the app phase's cheap look apart from its long wait`, () => {
    expect(said((say) => say('app', null))[0]).toContain(
      'Looking for an app attached to the dev server'
    );
    const waiting = said((say) => say('app', 120_000))[0]!;
    expect(waiting).toContain('Opening the app on the device, and waiting for it to attach');
    expect(waiting).toContain('(up to 2m)');
  });

  // The route the caller asked for, because "Opening the route" says nothing a reader of a long log
  // can use and the run has the answer in its own options.
  it(`names the route it is opening`, () => {
    const lines: string[] = [];
    const progress = vi.spyOn(Log, 'progress').mockImplementation((...message: string[]) => {
      lines.push(message.join(' '));
    });
    try {
      buildSmokeProgress(options({ route: '/notes' }))('route', null);
    } finally {
      progress.mockRestore();
    }

    expect(lines[0]).toContain('/notes');
  });
});

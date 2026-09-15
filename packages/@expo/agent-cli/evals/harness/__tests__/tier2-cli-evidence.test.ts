import { describe, expect, it } from 'vitest';

import { assertCliEvidence } from '../../tier2/cli-evidence.mjs';

const port = 8123;
const events = [
  { _e: 'root:init', format: 'v0-jsonl', formatVersion: 1 },
  { _e: 'cli:expo_passthrough', command: 'export', args: ['--platform', 'web'] },
  { _e: 'cli:expo_exit', code: 0 },
  { _e: 'cli:start_plan', mode: 'smart', target: 'web' },
  {
    _e: 'cli:start_plan_step',
    id: 'start',
    argv: ['expo', 'start', '--web', '--port', String(port)],
  },
  { _e: 'cli:dev_lock_acquired', port, pid: 123 },
];
const raw = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join('\n');

describe(assertCliEvidence, () => {
  it('should require the wrapper export event, executing dev plan, and the assigned server port', () => {
    expect(assertCliEvidence(raw(events), port)).toMatchObject({
      exportInvocations: 1,
      webDevPlans: 1,
    });
    for (const eventName of [
      'cli:expo_passthrough',
      'cli:expo_exit',
      'cli:start_plan',
      'cli:start_plan_step',
      'cli:dev_lock_acquired',
    ]) {
      expect(() =>
        assertCliEvidence(raw(events.filter((event) => event._e !== eventName)), port)
      ).toThrow();
    }
  });

  it('should not accept Expo-only logs, help, plan-only, reused servers or malformed evidence', () => {
    expect(() =>
      assertCliEvidence(raw([{ _e: 'expo:export', command: 'export' }]), port)
    ).toThrow();
    const replace = (name: string, patch: object) =>
      raw(events.map((event) => (event._e === name ? { ...event, ...patch } : event)));
    expect(() =>
      assertCliEvidence(replace('cli:expo_passthrough', { args: ['--help'] }), port)
    ).toThrow();
    expect(() => assertCliEvidence(replace('cli:start_plan', { mode: 'plan' }), port)).toThrow();
    expect(() =>
      assertCliEvidence(
        raw([
          ...events.slice(0, -1),
          { _e: 'cli:dev_detach', port, pid: 123, ready: true, alreadyRunning: true },
        ]),
        port
      )
    ).toThrow();
    expect(() => assertCliEvidence(replace('cli:expo_exit', { code: 1 }), port)).toThrow();
    expect(() =>
      assertCliEvidence(
        raw([
          ...events.map((event) => (event._e === 'cli:expo_exit' ? { ...event, code: 1 } : event)),
          { _e: 'root:init' },
          { _e: 'cli:expo_exit', code: 0 },
        ]),
        port
      )
    ).toThrow();
    expect(() => assertCliEvidence(raw(events) + '\ntruncated', port)).toThrow();
    expect(() => assertCliEvidence(raw(events), port + 1)).toThrow();
  });
});

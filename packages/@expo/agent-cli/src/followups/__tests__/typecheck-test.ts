import { buildTypeCheckFollowUps } from '../typecheck';

function ids(followups: { id: string }[]): string[] {
  return followups.map((followup) => followup.id);
}

describe(buildTypeCheckFollowUps, () => {
  it(`should ask for a rerun when the compiler reported something`, () => {
    const followups = buildTypeCheckFollowUps({ checked: true, errorCount: 7, platform: 'ios' });

    expect(ids(followups)).toEqual(['typecheck-rerun']);
    expect(followups[0]!.command).toBe('npx @expo/agent-cli typecheck');
  });

  // The escalation ladder of llp/0009: consistent types, then a bundle that builds, then an app
  // that does not throw. A clean run names the two rungs it did not cover.
  it(`should name the two gates a clean type check does not cover`, () => {
    const followups = buildTypeCheckFollowUps({ checked: true, errorCount: 0, platform: 'ios' });

    expect(ids(followups)).toEqual(['typecheck-smoke', 'typecheck-runtime-errors']);
    // The smoke gate carries the platform it needs — a bare `smoke` would exit 1 (F151).
    expect(followups[0]!.command).toBe('npx @expo/agent-cli smoke --ios');
    expect(followups[1]!.command).toContain('--fail-on-error');
  });

  // "Nothing was checked" must not read as "everything passed", and the follow-up is where the
  // difference is stated in a command rather than in a field.
  it(`should say that a run which checked nothing proves nothing`, () => {
    const followups = buildTypeCheckFollowUps({ checked: false, errorCount: 0, platform: 'android' });

    expect(ids(followups)).toEqual(['typecheck-not-run']);
    expect(followups[0]!.why).toContain('proves nothing');
    expect(followups[0]!.command).toBe('npx @expo/agent-cli smoke --android');
  });

  it(`should never offer more than three follow-ups`, () => {
    for (const input of [
      { checked: true, errorCount: 0, platform: 'ios' as const },
      { checked: true, errorCount: 3, platform: 'ios' as const },
      { checked: false, errorCount: 0, platform: 'ios' as const },
    ]) {
      expect(buildTypeCheckFollowUps(input).length).toBeLessThanOrEqual(3);
    }
  });
});

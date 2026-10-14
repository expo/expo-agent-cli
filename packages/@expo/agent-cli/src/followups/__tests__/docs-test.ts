import { buildDocsSyncFollowUps } from '../docs';

describe(buildDocsSyncFollowUps, () => {
  it('suggests a first search', () => {
    const [followup, ...rest] = buildDocsSyncFollowUps({ sdkMajor: null });
    expect(rest).toEqual([]);
    expect(followup).toMatchObject({
      id: 'docs-search',
      command: 'npx @expo/agent-cli docs:search <query>',
    });
    expect(followup!.why).not.toContain('--sdk');
  });

  it('names the synced version when --sdk chose it', () => {
    const [followup] = buildDocsSyncFollowUps({ sdkMajor: 55 });
    expect(followup!.why).toContain('--sdk 55');
  });
});

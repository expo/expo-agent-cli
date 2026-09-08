import { vol } from 'memfs';

import { getAllAgents } from '../../skills/agents';
import { findExecutableOnPath, spawnSubprocessAsync } from '../../utils/subprocess';
import { buildInstallerPlans, installAgentAsync } from '../installers';

vi.mock('../../utils/subprocess', () => ({
  findExecutableOnPath: vi.fn(),
  spawnSubprocessAsync: vi.fn(),
}));

const success = (data: unknown = {}) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: '' });
const agents = [
  { id: 'claude-code', displayName: 'Claude Code', skillsDir: '.claude/skills' },
  { id: 'codex', displayName: 'Codex', skillsDir: '.agents/skills' },
  { id: 'cursor', displayName: 'Cursor', skillsDir: '.agents/skills' },
];

beforeEach(() => {
  vol.reset();
  vi.mocked(findExecutableOnPath).mockImplementation((name) => `/bin/${name}`);
  vi.mocked(spawnSubprocessAsync).mockReset();
});

describe('Planning official Expo installation', () => {
  it.each(['project', 'user'] as const)(
    'should install Grok Build skills in %s scope',
    (scope) => {
      const grok = getAllAgents().find((agent) => agent.id === 'grok')!;
      const plan = buildInstallerPlans([grok], scope, '/destination')[0]!;
      expect(plan.provider).toBe('skills');
      expect(plan.commands).toEqual([
        {
          command: 'bunx',
          args: [
            'skills',
            'add',
            'expo/skills',
            '--skill',
            '*',
            '--agent',
            'grok',
            '--yes',
            ...(scope === 'user' ? ['--global'] : []),
          ],
        },
      ]);
    }
  );

  it('should use the requested plugins at user scope', () => {
    const plans = buildInstallerPlans(agents.slice(0, 2), 'user', '/home');
    expect(plans[0]!.commands[0]!.args).toEqual([
      'plugin',
      'install',
      'expo@claude-plugins-official',
      '--scope',
      'user',
    ]);
    expect(plans[1]!.commands.map((command) => command.args)).toEqual([
      ['plugin', 'marketplace', 'add', 'expo/skills', '--ref', 'main', '--json'],
      ['plugin', 'add', 'expo@expo-plugins', '--json'],
    ]);
  });

  it('should use project skills for Codex without silently widening scope', () => {
    const plan = buildInstallerPlans([agents[1]!], 'project', '/app')[0]!;
    expect(plan.provider).toBe('skills');
    expect(plan.commands[0]!.args).toEqual([
      'skills',
      'add',
      'expo/skills',
      '--skill',
      '*',
      '--agent',
      'codex',
      '--yes',
    ]);
    expect(plan.scope).toBe('project');
  });

  it('should fall back to npx and explicitly select global skills', () => {
    vi.mocked(findExecutableOnPath).mockImplementation((name) =>
      name === 'npx' ? '/bin/npx' : null
    );
    const plan = buildInstallerPlans([agents[2]!], 'user', '/home')[0]!;
    expect(plan.commands[0]!).toEqual({
      command: 'npx',
      args: [
        '--yes',
        'skills',
        'add',
        'expo/skills',
        '--skill',
        '*',
        '--agent',
        'cursor',
        '--yes',
        '--global',
      ],
    });
  });
});

describe('Installing official Expo knowledge', () => {
  it('should register the Codex marketplace before installing its plugin', async () => {
    vi.mocked(spawnSubprocessAsync)
      .mockResolvedValueOnce(success({ installed: [] }))
      .mockResolvedValueOnce(success({ marketplaces: [] }))
      .mockResolvedValueOnce(success({ marketplaceName: 'expo-plugins' }))
      .mockResolvedValueOnce(success({ pluginId: 'expo@expo-plugins' }))
      .mockResolvedValueOnce(
        success({ installed: [{ pluginId: 'expo@expo-plugins', enabled: true }] })
      );
    const plan = buildInstallerPlans([agents[1]!], 'user', '/home')[0]!;
    const result = await installAgentAsync(plan);
    expect(result.status).toBe('installed');
    expect(vi.mocked(spawnSubprocessAsync).mock.calls.map((call) => call[1])).toEqual([
      ['plugin', 'list', '--json'],
      ['plugin', 'marketplace', 'list', '--json'],
      ...plan.commands.map((command) => command.args),
      ['plugin', 'list', '--json'],
    ]);
  });

  it('should reuse a Claude plugin only when enabled in the requested project', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce(
      success([
        {
          id: 'expo@claude-plugins-official',
          scope: 'project',
          projectPath: '/app',
          enabled: true,
        },
      ])
    );
    const plan = buildInstallerPlans([agents[0]!], 'project', '/app')[0]!;
    expect((await installAgentAsync(plan)).status).toBe('already-present');
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should not treat another project installation as present', async () => {
    vi.mocked(spawnSubprocessAsync)
      .mockResolvedValueOnce(
        success([
          {
            id: 'expo@claude-plugins-official',
            scope: 'project',
            projectPath: '/another',
            enabled: true,
          },
        ])
      )
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(
        success([
          {
            id: 'expo@claude-plugins-official',
            scope: 'project',
            projectPath: '/app',
            enabled: true,
          },
        ])
      );
    const plan = buildInstallerPlans([agents[0]!], 'project', '/app')[0]!;
    expect((await installAgentAsync(plan)).status).toBe('installed');
  });

  it('should stop when the Codex marketplace has a conflicting source', async () => {
    vi.mocked(spawnSubprocessAsync)
      .mockResolvedValueOnce(success({ installed: [] }))
      .mockResolvedValueOnce(
        success({
          marketplaces: [{ name: 'expo-plugins', marketplaceSource: { source: 'someone/else' } }],
        })
      );
    const plan = buildInstallerPlans([agents[1]!], 'user', '/home')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('source'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(2);
  });

  it('should not install after a failed inspection or marketplace command', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'network unavailable',
    });
    const plan = buildInstallerPlans([agents[1]!], 'user', '/home')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('network unavailable'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should reject malformed inspection output', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce(success({ unexpected: [] }));
    const plan = buildInstallerPlans([agents[0]!], 'user', '/home')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('inspect'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should retain a disabled plugin without silently enabling it', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce(
      success([{ id: 'expo@claude-plugins-official', scope: 'user', enabled: false }])
    );
    const plan = buildInstallerPlans([agents[0]!], 'user', '/home')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('not enabled'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should reuse a registered Codex marketplace from the expected source', async () => {
    vi.mocked(spawnSubprocessAsync)
      .mockResolvedValueOnce(success({ installed: [] }))
      .mockResolvedValueOnce(
        success({
          marketplaces: [
            {
              name: 'expo-plugins',
              marketplaceSource: { source: 'https://github.com/expo/skills.git' },
            },
          ],
        })
      )
      .mockResolvedValueOnce(success({ pluginId: 'expo@expo-plugins' }))
      .mockResolvedValueOnce(
        success({ installed: [{ pluginId: 'expo@expo-plugins', enabled: true }] })
      );
    const plan = buildInstallerPlans([agents[1]!], 'user', '/home')[0]!;
    expect((await installAgentAsync(plan)).status).toBe('installed');
    expect(
      vi
        .mocked(spawnSubprocessAsync)
        .mock.calls.some((call) => call[1].includes('marketplace') && call[1].includes('add'))
    ).toBe(false);
  });

  it('should keep standalone project skills instead of adding a duplicate plugin', async () => {
    vol.fromJSON({ '/app/.claude/skills/expo-ui/SKILL.md': '# Expo UI' });
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce(success([]));
    const plan = buildInstallerPlans([agents[0]!], 'project', '/app')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('Standalone Expo skills'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
    expect(vol.readFileSync('/app/.claude/skills/expo-ui/SKILL.md', 'utf8')).toBe('# Expo UI');
  });

  it('should refuse to overwrite an Expo-named skill from another source', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce(
      success([{ name: 'expo-ui', source: 'custom/skills' }])
    );
    const plan = buildInstallerPlans([agents[2]!], 'project', '/app')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('ownership'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should report timeout without invoking later install steps', async () => {
    vi.mocked(spawnSubprocessAsync).mockResolvedValueOnce({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
    });
    const plan = buildInstallerPlans([agents[1]!], 'user', '/home')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('timed out'),
    });
    expect(spawnSubprocessAsync).toHaveBeenCalledTimes(1);
  });

  it('should verify installation rather than trusting a zero exit code', async () => {
    vi.mocked(spawnSubprocessAsync)
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce(success([]));
    const plan = buildInstallerPlans([agents[0]!], 'project', '/app')[0]!;
    expect(await installAgentAsync(plan)).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('after installation'),
    });
  });
});

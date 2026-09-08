import { vol } from 'memfs';
import path from 'path';

import { findExecutableOnPath } from '../../utils/subprocess';
import { findSetupProjectRoot, prepareSetupAsync } from '../plan';
import type { SetupPrompt } from '../prompt';
import type { SetupOptions } from '../types';

vi.mock('os', () => ({ default: { homedir: () => '/home' }, homedir: () => '/home' }));

vi.mock('../../utils/subprocess', () => ({ findExecutableOnPath: vi.fn(() => null) }));

const options = (overrides: Partial<SetupOptions> = {}): SetupOptions => ({
  agents: ['claude-code'],
  agentsMd: true,
  agentSkills: true,
  ...overrides,
});

const prompt = () => ({
  selectAgents: vi.fn<SetupPrompt['selectAgents']>().mockResolvedValue(['claude-code', 'codex']),
  selectScope: vi.fn<SetupPrompt['selectScope']>().mockResolvedValue('project'),
  confirm: vi.fn<SetupPrompt['confirm']>().mockResolvedValue(true),
});

beforeEach(() => {
  vol.reset();
  vi.mocked(findExecutableOnPath).mockReturnValue(null);
});

describe('Finding an optional setup project', () => {
  it('should offer home setup without an Expo package', () => {
    vol.fromJSON({ '/work/package.json': '{"name":"plain"}' });
    expect(findSetupProjectRoot('/work')).toBeNull();
    expect(findSetupProjectRoot('/elsewhere')).toBeNull();
  });

  it('should find a declared app from a nested directory without installed dependencies', () => {
    const appRoot = path.resolve('/work/app');
    vol.fromJSON({
      [path.join(appRoot, 'package.json')]: '{"dependencies":{"expo":"^55.0.0"}}',
    });
    expect(findSetupProjectRoot(path.join(appRoot, 'src'))).toBe(appRoot);
  });
});

describe('Preparing agent setup', () => {
  it('should default to user scope outside a project with explicit consent', async () => {
    const plan = await prepareSetupAsync(null, options({ yes: true }));
    expect(plan).toMatchObject({ scope: 'user', destination: '/home', confirmed: true });
  });

  it('should reject project scope when no Expo project exists', async () => {
    await expect(prepareSetupAsync(null, options({ yes: true, scope: 'project' }))).rejects.toThrow(
      'No Expo project'
    );
  });

  it('should reject noninteractive setup without consent', async () => {
    await expect(prepareSetupAsync(null, options(), null)).rejects.toThrow('--yes');
  });

  it('should allow selecting home scope inside a project and declining without writes', async () => {
    vol.fromJSON({ '/app/package.json': '{}' });
    const before = vol.toJSON();
    const questions = prompt();
    questions.selectScope.mockResolvedValue('user');
    questions.confirm.mockResolvedValue(false);
    const plan = await prepareSetupAsync('/app', options(), questions);
    expect(plan).toMatchObject({ scope: 'user', confirmed: false });
    expect(vol.toJSON()).toEqual(before);
  });

  it('should select both detected plugin agents and explain Codex project skills before confirming', async () => {
    vi.mocked(findExecutableOnPath).mockImplementation((name) =>
      name === 'claude' || name === 'codex' ? `/bin/${name}` : null
    );
    const questions = prompt();
    const plan = await prepareSetupAsync('/app', options({ agents: [] }), questions);
    expect(plan.agents.map((agent) => agent.id)).toEqual(['claude-code', 'codex']);
    expect(plan.installers.map((item) => item.provider)).toEqual(['claude', 'skills']);
    expect(questions.selectAgents).toHaveBeenCalledWith(expect.any(Array), [
      'claude-code',
      'codex',
    ]);
    expect(questions.selectScope).toHaveBeenCalledWith('/app', '/home', true);
  });

  it('should cancel on EOF before selecting agents', async () => {
    const questions = prompt();
    questions.selectAgents.mockResolvedValue(null);
    const plan = await prepareSetupAsync(null, options({ agents: [] }), questions);
    expect(plan.confirmed).toBe(false);
    expect(questions.confirm).not.toHaveBeenCalled();
  });

  it('should skip every prompt when explicit consent is supplied', async () => {
    const questions = prompt();
    const plan = await prepareSetupAsync('/app', options({ yes: true }), questions);
    expect(plan.confirmed).toBe(true);
    expect(questions.selectAgents).not.toHaveBeenCalled();
    expect(questions.selectScope).not.toHaveBeenCalled();
    expect(questions.confirm).not.toHaveBeenCalled();
  });

  it('should cancel before confirmation when scope selection is cancelled', async () => {
    const questions = prompt();
    questions.selectScope.mockResolvedValue(null);
    const plan = await prepareSetupAsync('/app', options(), questions);
    expect(plan.confirmed).toBe(false);
    expect(questions.confirm).not.toHaveBeenCalled();
  });
});

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
    await expect(prepareSetupAsync(null, options({ yes: true, project: true }))).rejects.toThrow(
      'No Expo project'
    );
  });

  it('should reject noninteractive setup without consent', async () => {
    await expect(prepareSetupAsync(null, options(), null)).rejects.toThrow('--yes');
  });

  it('should default to home scope inside a project and allow declining without writes', async () => {
    vol.fromJSON({ '/app/package.json': '{}' });
    const before = vol.toJSON();
    const questions = prompt();
    questions.confirm.mockResolvedValue(false);
    const plan = await prepareSetupAsync('/app', options(), questions);
    expect(plan).toMatchObject({ scope: 'user', confirmed: false });
    expect(vol.toJSON()).toEqual(before);
  });

  it('should select both detected plugin agents and install plugins at home by default', async () => {
    vi.mocked(findExecutableOnPath).mockImplementation((name) =>
      name === 'claude' || name === 'codex' ? `/bin/${name}` : null
    );
    const questions = prompt();
    const plan = await prepareSetupAsync('/app', options({ agents: [] }), questions);
    expect(plan.agents.map((agent) => agent.id)).toEqual(['claude-code', 'codex']);
    expect(plan).toMatchObject({ scope: 'user', destination: '/home', confirmed: true });
    expect(plan.installers.map((item) => item.provider)).toEqual(['claude', 'codex']);
    expect(questions.selectAgents).toHaveBeenCalledWith(expect.any(Array), [
      'claude-code',
      'codex',
    ]);
    expect(questions.confirm).toHaveBeenCalledOnce();
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
    expect(plan.scope).toBe('user');
    expect(questions.selectAgents).not.toHaveBeenCalled();
    expect(questions.confirm).not.toHaveBeenCalled();
  });

  it('should install Codex skills in the project only when explicitly requested', async () => {
    const questions = prompt();
    const plan = await prepareSetupAsync(
      '/app',
      options({ project: true, agents: ['codex'] }),
      questions
    );
    expect(plan).toMatchObject({ scope: 'project', destination: '/app', confirmed: true });
    expect(plan.installers.map((item) => item.provider)).toEqual(['skills']);
    expect(questions.confirm).toHaveBeenCalledOnce();
  });
});

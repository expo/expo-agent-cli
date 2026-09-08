import { vol } from 'memfs';

import {
  AGENTS_MD_FILE,
  applyManagedBlock,
  BLOCK_END,
  BLOCK_START,
  ensureClaudeMdReferenceAsync,
  writeManagedBlockAsync,
} from '../agentsMd';

const projectRoot = '/project';

beforeEach(() => {
  vol.reset();
  vol.mkdirSync(projectRoot, { recursive: true });
});

describe(applyManagedBlock, () => {
  it('should create a file holding only the wrapped block', () => {
    expect(applyManagedBlock(null, 'Body line.')).toBe(
      [BLOCK_START, 'Body line.', BLOCK_END, ''].join('\n')
    );
  });

  it('should treat an empty file like a missing one', () => {
    expect(applyManagedBlock('', 'Body line.')).toBe(
      [BLOCK_START, 'Body line.', BLOCK_END, ''].join('\n')
    );
  });

  it('should append the block after existing content, separated by a blank line', () => {
    const result = applyManagedBlock('# My rules\n\nAlways run the tests.\n', 'Body line.');

    expect(result).toBe(
      [
        '# My rules',
        '',
        'Always run the tests.',
        '',
        BLOCK_START,
        'Body line.',
        BLOCK_END,
        '',
      ].join('\n')
    );
  });

  it('should replace only the block and keep user content byte for byte', () => {
    const before = [
      '# My rules',
      '',
      'Keep this exact    spacing.',
      '',
      BLOCK_START,
      'Old body.',
      'More old body.',
      BLOCK_END,
      '',
      '## After',
      '',
      'And this too.',
      '',
    ].join('\n');

    const result = applyManagedBlock(before, 'New body.');

    expect(result).toBe(
      [
        '# My rules',
        '',
        'Keep this exact    spacing.',
        '',
        BLOCK_START,
        'New body.',
        BLOCK_END,
        '',
        '## After',
        '',
        'And this too.',
        '',
      ].join('\n')
    );
  });

  it('should be idempotent', () => {
    const once = applyManagedBlock('# My rules\n', 'Body line.\nSecond line.');
    const twice = applyManagedBlock(once, 'Body line.\nSecond line.');

    expect(twice).toBe(once);
  });

  it('should ignore trailing newlines of the generated body', () => {
    expect(applyManagedBlock(null, 'Body line.\n\n')).toBe(applyManagedBlock(null, 'Body line.'));
  });

  it('should report an unclosed managed block instead of overwriting the rest of the file', () => {
    const before = ['# My rules', BLOCK_START, 'Old body.', '', 'User content.', ''].join('\n');

    expect(() => applyManagedBlock(before, 'New body.')).toThrow(
      /END EXPO AGENT CLI MANAGED BLOCK/
    );
    // Nothing after the start marker is lost, because nothing is written at all.
    expect(before).toContain('User content.');
  });
});

describe(writeManagedBlockAsync, () => {
  it.each([
    ['npx expo start --clear', 'npx @expo/agent-cli start --clear'],
    ['bunx expo start --web', 'bunx @expo/agent-cli start --web'],
    ['expo start', 'npx @expo/agent-cli start'],
    ['npx --yes expo lint', 'npx --yes @expo/agent-cli lint'],
    ['bunx --bun expo lint --fix', 'bunx --bun @expo/agent-cli lint --fix'],
    ['expo lint', 'npx @expo/agent-cli lint'],
    ['npx expo-doctor', 'npx @expo/agent-cli doctor'],
    ['bunx expo-doctor', 'bunx @expo/agent-cli doctor'],
    ['npx -y expo-doctor@latest', 'npx -y @expo/agent-cli doctor'],
    ['expo-doctor', 'npx @expo/agent-cli doctor'],
  ])('should migrate %s in inline and fenced examples', async (command, expected) => {
    vol.writeFileSync(
      `${projectRoot}/AGENTS.md`,
      `Use \`${command}\`.\n\n\`\`\`sh\n${command}\n\`\`\`\n`
    );

    await writeManagedBlockAsync(projectRoot, 'Body line.');

    expect(vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8')).toBe(
      applyManagedBlock(`Use \`${expected}\`.\n\n\`\`\`sh\n${expected}\n\`\`\`\n`, 'Body line.')
    );
    expect((await writeManagedBlockAsync(projectRoot, 'Body line.')).action).toBe('skipped');
  });

  it('should rewrite Expo install instructions while preserving runners, arguments, and other text', async () => {
    const before = [
      '# My rules',
      'Use `bunx expo install expo-camera` for compatible versions.',
      '```sh',
      'npx --yes expo install --fix',
      'bunx --bun expo install expo-router -- --dev',
      'expo install expo-sqlite',
      '```',
      'Keep `npx expo prebuild`, `expo prebuild`, and `npx @expo/agent-cli install`.',
      'Keep `expo starter`, `expo lint-extra`, `./expo-doctor`, and `expo-doctor-helper`.',
      'Keep `npx expo-doctor@1.0.0`, `npx expo-doctor@next`, and `pnpm expo-doctor`.',
      'Keep `my-expo install`, `./expo install`, and `expo installer`.',
      'Keep `pnpm expo install`, `yarn expo install`, and `npx --offline expo install`.',
      '',
    ].join('\n');
    vol.writeFileSync(`${projectRoot}/AGENTS.md`, before);

    await writeManagedBlockAsync(projectRoot, 'Body line.');

    const contents = vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8');
    expect(contents).toBe(
      applyManagedBlock(
        before
          .replace('bunx expo install', 'bunx @expo/agent-cli install')
          .replace('npx --yes expo install', 'npx --yes @expo/agent-cli install')
          .replace('bunx --bun expo install', 'bunx --bun @expo/agent-cli install')
          .replace('\nexpo install', '\nnpx @expo/agent-cli install'),
        'Body line.'
      )
    );
    expect((await writeManagedBlockAsync(projectRoot, 'Body line.')).action).toBe('skipped');
  });

  it('should create AGENTS.md when the project has none', async () => {
    await expect(writeManagedBlockAsync(projectRoot, 'Body line.')).resolves.toEqual({
      path: AGENTS_MD_FILE,
      action: 'created',
    });

    expect(vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8')).toBe(
      [BLOCK_START, 'Body line.', BLOCK_END, ''].join('\n')
    );
  });

  it('should update the block of an existing file', async () => {
    vol.writeFileSync(
      `${projectRoot}/AGENTS.md`,
      [BLOCK_START, 'Old body.', BLOCK_END, ''].join('\n')
    );

    await expect(writeManagedBlockAsync(projectRoot, 'New body.')).resolves.toEqual({
      path: AGENTS_MD_FILE,
      action: 'updated',
    });

    expect(vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8')).toContain('New body.');
  });

  it('should report a file that already matches as skipped, and not rewrite it', async () => {
    await writeManagedBlockAsync(projectRoot, 'Body line.');
    const before = vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8');

    await expect(writeManagedBlockAsync(projectRoot, 'Body line.')).resolves.toEqual({
      path: AGENTS_MD_FILE,
      action: 'skipped',
    });

    expect(vol.readFileSync(`${projectRoot}/AGENTS.md`, 'utf8')).toBe(before);
  });
});

describe(ensureClaudeMdReferenceAsync, () => {
  beforeEach(() => vol.writeFileSync(`${projectRoot}/AGENTS.md`, '# Shared rules\n'));

  it('should create a Claude import when the file is missing', async () => {
    expect(await ensureClaudeMdReferenceAsync(projectRoot)).toEqual({
      path: 'CLAUDE.md',
      action: 'created',
    });
    expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toBe('@AGENTS.md\n');
  });

  it('should preserve existing content and append an import even when it mentions AGENTS.md', async () => {
    const before = '# Rules\nSee AGENTS.md.\n';
    vol.writeFileSync(`${projectRoot}/CLAUDE.md`, before);
    expect(await ensureClaudeMdReferenceAsync(projectRoot)).toEqual({
      path: 'CLAUDE.md',
      action: 'updated',
    });
    expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toBe(before + '\n@AGENTS.md\n');
    expect((await ensureClaudeMdReferenceAsync(projectRoot)).action).toBe('skipped');
  });

  it.each(['@AGENTS.md\n', 'See @./AGENTS.md for shared rules.\n'])(
    'should retain an existing import (%s)',
    async (contents) => {
      vol.writeFileSync(`${projectRoot}/CLAUDE.md`, contents);
      expect((await ensureClaudeMdReferenceAsync(projectRoot)).action).toBe('skipped');
      expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toBe(contents);
    }
  );

  it('should ignore imports inside comments and code examples', async () => {
    const contents = '<!-- @AGENTS.md -->\n```md\n@AGENTS.md\n```\n`@AGENTS.md`\n';
    vol.writeFileSync(`${projectRoot}/CLAUDE.md`, contents);
    await ensureClaudeMdReferenceAsync(projectRoot);
    expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toBe(contents + '\n@AGENTS.md\n');
  });

  it.each(['```md\nExample', '<!-- Notes'])(
    'should refuse to append inside an unclosed block (%s)',
    async (contents) => {
      vol.writeFileSync(`${projectRoot}/CLAUDE.md`, contents);
      await expect(ensureClaudeMdReferenceAsync(projectRoot)).rejects.toThrow(/unclosed/);
      expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toBe(contents);
    }
  );

  it('should reuse a CLAUDE.md symlink to AGENTS.md', async () => {
    vol.symlinkSync(`${projectRoot}/AGENTS.md`, `${projectRoot}/CLAUDE.md`);
    expect((await ensureClaudeMdReferenceAsync(projectRoot)).action).toBe('skipped');
    expect(vol.lstatSync(`${projectRoot}/CLAUDE.md`).isSymbolicLink()).toBe(true);
  });

  it('should refuse to write through other CLAUDE.md symlinks', async () => {
    vol.writeFileSync('/outside.md', '# Global rules');
    vol.symlinkSync('/outside.md', `${projectRoot}/CLAUDE.md`);
    await expect(ensureClaudeMdReferenceAsync(projectRoot)).rejects.toThrow(/symlink/i);
    expect(vol.readFileSync('/outside.md', 'utf8')).toBe('# Global rules');
  });

  it('should share the managed block when AGENTS.md links to a regular root CLAUDE.md', async () => {
    vol.unlinkSync(`${projectRoot}/AGENTS.md`);
    vol.writeFileSync(`${projectRoot}/CLAUDE.md`, '# Claude rules\n');
    vol.symlinkSync(`${projectRoot}/CLAUDE.md`, `${projectRoot}/AGENTS.md`);
    await writeManagedBlockAsync(projectRoot, 'Shared block');
    expect((await ensureClaudeMdReferenceAsync(projectRoot)).action).toBe('skipped');
    expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).toContain('Shared block');
    expect(vol.readFileSync(`${projectRoot}/CLAUDE.md`, 'utf8')).not.toContain('@AGENTS.md');
  });
});

describe('Writing AGENTS.md that is not a regular file', () => {
  it('should refuse to write through a symlink that leaves the project', async () => {
    vol.mkdirSync('/outside', { recursive: true });
    vol.writeFileSync('/outside/authorized_keys', 'ssh-ed25519 AAAA real@key\n');
    vol.symlinkSync('/outside/authorized_keys', `${projectRoot}/AGENTS.md`);

    await expect(writeManagedBlockAsync(projectRoot, 'Body line.')).rejects.toThrow(/symlink/i);

    expect(vol.readFileSync('/outside/authorized_keys', 'utf8')).toBe(
      'ssh-ed25519 AAAA real@key\n'
    );
  });

  it('should refuse to write through a symlink that stays inside the project', async () => {
    vol.writeFileSync(`${projectRoot}/notes.md`, 'mine\n');
    vol.symlinkSync(`${projectRoot}/notes.md`, `${projectRoot}/AGENTS.md`);

    await expect(writeManagedBlockAsync(projectRoot, 'Body line.')).rejects.toThrow(/symlink/i);

    expect(vol.readFileSync(`${projectRoot}/notes.md`, 'utf8')).toBe('mine\n');
  });

  it('should still write a regular AGENTS.md', async () => {
    vol.writeFileSync(`${projectRoot}/AGENTS.md`, '# Mine\n');

    await expect(writeManagedBlockAsync(projectRoot, 'Body line.')).resolves.toEqual({
      path: AGENTS_MD_FILE,
      action: 'updated',
    });
  });
});

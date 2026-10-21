import { isPromptShaped, lastNonEmptyLine } from '../promptShape';

describe(isPromptShaped, () => {
  it.each([
    '? Select a platform',
    'Which platform would you like to build for?',
    'Do you want to continue (y/N)',
    'Overwrite the file? (Y/n)',
    'Password:',
    'Enter the keystore passphrase',
    'Apple ID:',
  ])('recognises %p as a question', (line) => {
    expect(isPromptShaped(line)).toBe(true);
  });

  it.each(['Bundling 1200 modules', 'Compiling native code', 'Uploading to EAS Hosting...', ''])(
    'does not mistake %p for a question',
    (line) => {
      expect(isPromptShaped(line)).toBe(false);
    }
  );
});

describe(lastNonEmptyLine, () => {
  it('skips the blank tail a prompt leaves behind', () => {
    expect(lastNonEmptyLine('Bundling\n? Select a platform\n\n   \n')).toBe('? Select a platform');
  });

  it('answers null when nothing was printed', () => {
    expect(lastNonEmptyLine('\n \n')).toBeNull();
  });
});

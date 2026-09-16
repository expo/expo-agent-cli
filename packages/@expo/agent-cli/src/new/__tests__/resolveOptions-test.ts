import { resolveNewOptions } from '../resolveOptions';

describe(resolveNewOptions, () => {
  it(`should resolve the defaults from a directory alone`, () => {
    expect(resolveNewOptions(['my-app'])).toEqual({
      directory: 'my-app',
      name: undefined,
      template: undefined,
      example: undefined,
      install: true,
      git: true,
      json: false,
      followups: true,
    });
  });

  it(`should resolve every flag of the command`, () => {
    expect(
      resolveNewOptions([
        'apps/my-app',
        '--name',
        'My App',
        '--json',
        '--no-install',
        '--no-git',
        '--no-followups',
      ])
    ).toEqual({
      directory: 'apps/my-app',
      name: 'My App',
      template: undefined,
      example: undefined,
      install: false,
      git: false,
      json: true,
      followups: false,
    });
  });

  it(`should throw when no directory is given`, () => {
    // The directory is what makes the command headless: prompting for it is what `new` exists to
    // avoid (llp/0007 §new).
    expect(() => resolveNewOptions([])).toThrow(/Missing directory/);
    expect(() => resolveNewOptions(['--json'])).toThrow(/Missing directory/);
  });

  it(`should throw when more than one directory is given`, () => {
    expect(() => resolveNewOptions(['my-app', 'other-app'])).toThrow(/Expected one directory/);
  });

  it(`should throw for an empty --name`, () => {
    expect(() => resolveNewOptions(['my-app', '--name', '  '])).toThrow(/--name/);
  });

  it.each([
    ['--template', 'template', 'blank-typescript'],
    ['-t', 'template', 'default@sdk-55'],
    ['--example', 'example', 'with-router'],
    ['-e', 'example', 'with-router'],
  ])('should resolve %s as %s', (flag, option, value) => {
    expect(resolveNewOptions([flag, value, 'my-app'])).toMatchObject({
      directory: 'my-app',
      [option]: value,
    });
  });

  it.each(['--template', '--example'])('should resolve an inline %s value', (flag) => {
    expect(resolveNewOptions(['my-app', `${flag}=custom-starter`])).toMatchObject({
      [flag.slice(2)]: 'custom-starter',
    });
  });

  it.each(['--template', '-t', '--example', '-e'])(
    'should reject a missing or empty %s value',
    (flag) => {
      for (const value of [[], [''], ['  '], ['--no-install']]) {
        expect(() => resolveNewOptions(['my-app', flag, ...value])).toThrow();
      }
    }
  );

  it('should reject selecting both a template and an example', () => {
    expect(() => resolveNewOptions(['my-app', '-t', 'blank', '-e', 'with-router'])).toThrow(
      /--template.*--example/
    );
  });

  it(`should throw for an unknown flag`, () => {
    expect(() => resolveNewOptions(['my-app', '--unknown'])).toThrow(/--unknown/);
  });
});

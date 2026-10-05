import { parseSdkFlag, selectSdkVersion } from '../version';

const available = ['v58.0.0', 'v57.0.0', 'v55.0.0'] as const;
const base = { latest: 'v57.0.0' as const, available: [...available] };

describe(selectSdkVersion, () => {
  it('uses --sdk when a bundle exists for it', () => {
    expect(selectSdkVersion({ ...base, flag: '55', projectSdkVersion: '57.0.1' })).toEqual({
      source: 'explicit',
      version: 'v55.0.0',
    });
  });

  it('fails on --sdk without a bundle, listing the versions that exist', () => {
    expect(() => selectSdkVersion({ ...base, flag: '50', projectSdkVersion: null })).toThrow(
      expect.objectContaining({
        code: 'DOCS_SDK_UNAVAILABLE',
        message: expect.stringContaining('v58.0.0, v57.0.0, v55.0.0'),
      })
    );
  });

  it(`uses the project's SDK`, () => {
    expect(selectSdkVersion({ ...base, flag: undefined, projectSdkVersion: '55.0.12' })).toEqual({
      source: 'project',
      version: 'v55.0.0',
      projectSdkVersion: '55.0.12',
    });
  });

  it('uses the beta bundle for a canary of the beta major', () => {
    expect(
      selectSdkVersion({ ...base, flag: undefined, projectSdkVersion: '58.0.0-canary-20260901' })
    ).toMatchObject({ source: 'project', version: 'v58.0.0' });
  });

  it('falls back to latest for a major without a bundle, and says why', () => {
    const selection = selectSdkVersion({ ...base, flag: undefined, projectSdkVersion: '50.0.0' });
    expect(selection).toMatchObject({ source: 'latest', version: 'v57.0.0' });
    expect(selection.source === 'latest' && selection.reason).toContain('50.0.0');
  });

  it('falls back to latest for a version it cannot read', () => {
    expect(
      selectSdkVersion({ ...base, flag: undefined, projectSdkVersion: 'canary' })
    ).toMatchObject({ source: 'latest', version: 'v57.0.0' });
  });

  it('uses latest outside a project, without a reason', () => {
    expect(selectSdkVersion({ ...base, flag: undefined, projectSdkVersion: null })).toEqual({
      source: 'latest',
      version: 'v57.0.0',
      reason: null,
    });
  });
});

describe(parseSdkFlag, () => {
  it.each(['57', 'v57', '57.0.0', 'v57.0.0'])('reads %s', (flag) => {
    expect(parseSdkFlag(flag)).toBe('v57.0.0');
  });

  it.each(['latest', '57.1.0', 'abc', ''])('rejects %j', (flag) => {
    expect(() => parseSdkFlag(flag)).toThrow(expect.objectContaining({ code: 'BAD_ARGS' }));
  });
});

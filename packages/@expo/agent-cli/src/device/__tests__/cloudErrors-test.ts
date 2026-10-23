// @ref llp/0035-one-device-per-worktree.rfc.md §One session per worktree
// @ref llp/0035-one-device-per-worktree.rfc.md §Session guard
import { smokeSessionResult } from '../../smoke/smokeAsync';
import { cloudPlatformMismatchError, otherPlatformSessionError } from '../cloudErrors';
import { cloudSessionMismatchError } from '../cloudSimulator';

describe('otherPlatformSessionError', () => {
  it('names navigate to reuse the session beside a running dev server', () => {
    const { message } = otherPlatformSessionError('android', {
      wanted: 'ios',
      sessionId: 's1',
      devServerRunning: true,
    });

    expect(message).toContain('navigate / --eas --android');
    expect(message).not.toContain('dev --android --eas --detach');
  });

  it('names dev --detach to reuse the session when no dev server runs', () => {
    const { message } = otherPlatformSessionError('android', {
      wanted: 'ios',
      sessionId: 's1',
      devServerRunning: false,
    });

    expect(message).toContain('dev --android --eas --detach');
  });

  it.each([
    ['ios', 'android', 'starts an iOS session.'],
    ['android', 'ios', 'starts an Android session.'],
  ] as const)('writes a noun after the article for %s', (wanted, session, text) => {
    const { message } = otherPlatformSessionError(session, {
      wanted,
      sessionId: 's1',
      devServerRunning: true,
    });

    expect(message).toContain(text);
    expect(message).not.toMatch(/ one\./);
  });
});

describe('cloudPlatformMismatchError', () => {
  it('writes a noun after the article', () => {
    expect(cloudPlatformMismatchError('ios', 'android', 's1').message).toContain(
      'starts an iOS session.'
    );
  });
});

describe('cloudSessionMismatchError', () => {
  it('names both real dev commands, not a placeholder flag', () => {
    const { message } = cloudSessionMismatchError('s1', null);

    expect(message).toContain('dev --ios --eas"');
    expect(message).toContain('dev --android --eas"');
    expect(message).not.toContain('--<platform>');
  });
});

describe('smokeSessionResult', () => {
  it('reports the What and How of a refusal as the reason', () => {
    const refusal = otherPlatformSessionError('android', {
      wanted: 'ios',
      sessionId: 's1',
      devServerRunning: true,
    });

    const result = smokeSessionResult({
      ok: false,
      sessionId: null,
      started: false,
      reason: refusal.message.split('\n')[0]!,
      refusal,
    });

    expect(result.reason).toContain('dev:stop --eas');
    expect(result.reason).toContain(refusal.message.split('\n')[0]!);
  });

  it('keeps the reason when there is no refusal', () => {
    expect(
      smokeSessionResult({ ok: false, sessionId: null, started: false, reason: 'x' }).reason
    ).toBe('x');
  });
});

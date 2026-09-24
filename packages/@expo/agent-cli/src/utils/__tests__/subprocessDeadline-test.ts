import { extendSubprocessDeadline, withSubprocessDeadlineAsync } from '../subprocessDeadline';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe(withSubprocessDeadlineAsync, () => {
  it(`rejects with the message once the budget is spent`, async () => {
    await expect(withSubprocessDeadlineAsync(20, 'out of time', () => sleep(200))).rejects.toThrow(
      'out of time'
    );
  });

  it(`resolves with the work's answer inside the budget`, async () => {
    await expect(withSubprocessDeadlineAsync(500, 'out of time', async () => 'done')).resolves.toBe(
      'done'
    );
  });
});

describe(extendSubprocessDeadline, () => {
  // The phone probe pays for its launch from inside the read, so the section budget stays sized
  // for file reads until a phone is really launched on.
  it(`gives the enclosing deadline more time from now`, async () => {
    await expect(
      withSubprocessDeadlineAsync(30, 'out of time', async () => {
        extendSubprocessDeadline(400);
        await sleep(120);
        return 'done';
      })
    ).resolves.toBe('done');
  });

  it(`is a no-op outside a deadline`, () => {
    expect(() => extendSubprocessDeadline(1000)).not.toThrow();
  });
});

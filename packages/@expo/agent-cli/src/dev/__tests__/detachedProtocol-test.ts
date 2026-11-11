import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { lockAddressFor } from '../../devLock/address';
import { exchangeAttemptAsync, listenAttemptAsync } from '../detachedProtocol';

vi.unmock('fs');
vi.unmock('node:fs');

it('bounds invalid control frames without cancelling the captured attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'));
  const id = randomUUID();
  const address = lockAddressFor(root, { name: `detached-${id}` }).address;
  let cancelled = 0;
  const control = await listenAttemptAsync(address, id, {
    inspect: () => ({ kind: 'starting', metro: { kind: 'awaiting', plannedPort: null } }),
    cancel: () => {
      cancelled++;
    },
  });
  const frame = (data: string) =>
    new Promise<void>((resolve) => {
      const socket = net.connect(address, () => socket.end(data));
      socket.on('error', () => {});
      socket.once('close', () => resolve());
    });
  try {
    for (const data of [
      '',
      '{\n',
      'x'.repeat(16_385),
      JSON.stringify({
        version: 1,
        id: randomUUID(),
        kind: 'cancel',
        intent: { signal: 'SIGTERM' },
      }) + '\n',
      JSON.stringify({
        version: 2,
        id,
        kind: 'cancel',
        intent: { signal: 'SIGTERM' },
      }) + '\n',
    ])
      await frame(data);
    expect(cancelled).toBe(0);
    expect(await exchangeAttemptAsync(address, id)).toMatchObject({
      connection: 'live',
      progress: { kind: 'starting' },
      acknowledged: false,
    });
  } finally {
    control.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('reports acceptance separately from completed captured cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-'));
  const id = randomUUID();
  const address = lockAddressFor(root, { name: `detached-${id}` }).address;
  let accept!: () => void;
  const accepted = new Promise<void>((resolve) => {
    accept = resolve;
  });
  const control = await listenAttemptAsync(address, id, {
    inspect: () => ({ kind: 'stopping', metro: { kind: 'exited', server: null } }),
    cancel: accept,
  });
  try {
    const request = exchangeAttemptAsync(address, id, { signal: 'SIGTERM', eas: true });
    await accepted;
    control.close({
      kind: 'finished',
      metro: { kind: 'exited', server: null },
      admission: 'released',
      cleanup: {
        sessions: [
          { session: { id: 'captured', platform: 'ios', origin: 'started' }, outcome: 'stopped' },
        ],
        devices: [],
      },
    });
    expect(await request).toMatchObject({
      acknowledged: true,
      finished: {
        admission: 'released',
        cleanup: { sessions: [{ session: { id: 'captured' }, outcome: 'stopped' }] },
      },
    });
  } finally {
    control.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

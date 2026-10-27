import fs from 'fs';
import { vol } from 'memfs';

import {
  openDetachedLogSync,
  publishDetachedLog,
  readDetachedLogSync,
  readDetachedLogFileSync,
} from '../logFile';

afterEach(() => vol.reset());

it('a candidate cannot change the published current log', () => {
  const root = '/log-readers';
  const owner = openDetachedLogSync(root);
  fs.closeSync(owner.fd);
  fs.writeFileSync(owner.logFile, 'owner output\n');
  publishDetachedLog(root, owner.logFile);
  const contender = openDetachedLogSync(root);
  fs.closeSync(contender.fd);
  fs.writeFileSync(contender.logFile, 'contender output\n');

  expect(readDetachedLogSync(root, 10)).toMatchObject({
    logFile: owner.logFile,
    lines: ['owner output'],
  });
  expect(readDetachedLogFileSync(contender.logFile, 10)?.lines).toEqual(['contender output']);
  publishDetachedLog(root, contender.logFile);
  expect(readDetachedLogFileSync(owner.logFile, 10)?.lines).toEqual(['owner output']);
});

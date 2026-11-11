import { resolveDevOptions } from '../resolveOptions';
import {
  equivalentStartupRequest,
  parseStartupRequest,
  startupRequestFrom,
} from '../startupRequest';
import { parseAgentCliSettings } from '../../settings/parse';

const request = (args: string[]) => startupRequestFrom(resolveDevOptions(['--ios', ...args]));

it.each([
  [
    ['--go', '--clear', '--max-workers', '2'],
    ['--max-workers=02', '-c', '-g', '--json'],
  ],
  [['--eas'], ['--eas', '--host', 'tunnel', '--detach', '--wait-ready']],
  [
    ['--localhost', '--minify'],
    ['-m', '--host=localhost', '--no-followups'],
  ],
])('normalizes equivalent startup options %j and %j', (left, right) => {
  const normalized = request(left);
  expect(equivalentStartupRequest(normalized, request(right))).toBe(true);
  expect(parseStartupRequest(JSON.parse(JSON.stringify(normalized)))).toEqual(normalized);
});

it.each([
  ['--no-open'],
  ['--no-fingerprint-cache'],
  ['--no-agent-skills'],
  ['--clear'],
  ['--port', '8081'],
  ['--device', 'Named simulator'],
  ['--go'],
  ['--local'],
  ['--', '--clear'],
  ['--scheme', 'other'],
])('keeps effective startup changes distinct %j', (...args) => {
  expect(equivalentStartupRequest(request([]), request(args))).toBe(false);
});

it('keeps separately configured EAS build and local device intent', () => {
  const settings = parseAgentCliSettings({ buildBackend: 'eas', target: 'dev-build' }, 'test');
  const options = resolveDevOptions(['--ios'], settings);
  expect(startupRequestFrom(options, settings)).toMatchObject({
    build: 'eas',
    deviceBackend: 'local',
    target: 'dev-build',
  });
  expect(equivalentStartupRequest(startupRequestFrom(options, settings), request(['--eas']))).toBe(
    false
  );
});

import { parseLsofFields, parseNetstatListeners } from '../portListener';

describe(parseLsofFields, () => {
  // `lsof -F` writes one field per line, the first character naming the field. The columns are
  // parsed instead of the default table because a command name with a space in it shifts every
  // column after it, silently.
  it.each([
    ['one listener', 'p65866\ncnode\n', [{ pid: 65866, command: 'node' }]],
    // Two processes can hold one port, on [::1] and 127.0.0.1.
    [
      'every listener of a port, each once',
      'p100\ncnode\np200\ncother\np100\ncnode\n',
      [
        { pid: 100, command: 'node' },
        { pid: 200, command: 'other' },
      ],
    ],
    [
      'a command name that has a space in it',
      'p42\ncMy App Helper\n',
      [{ pid: 42, command: 'My App Helper' }],
    ],
    ['no process record', 'cnode\n', []],
    ['a pid that is not a pid', 'pnope\ncnode\n', []],
  ])(`should read %s`, (_, stdout, listeners) => {
    expect(parseLsofFields(stdout)).toEqual(listeners);
  });
});

describe(parseNetstatListeners, () => {
  const output = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       988',
    '  TCP    127.0.0.1:8081         0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:8082         0.0.0.0:0              LISTENING       7',
    '  TCP    127.0.0.1:8081         127.0.0.1:51234        ESTABLISHED     9999',
    '  TCP    [::1]:8081             [::]:0                 LISTENING       5151',
    '  TCP    [::]:8081              [::]:0                 LISTENING       4242',
  ].join('\n');

  // An established connection to the same port is not a listener, and taking its pid would
  // report — and with --force, kill — whatever happened to be talking to the dev server.
  it(`should read every listening pid of a port, each once, and no connection`, () => {
    expect(parseNetstatListeners(output, 8081)).toEqual([4242, 5151]);
  });

  it(`should not match a port that is only a suffix of another`, () => {
    expect(parseNetstatListeners(output, 81)).toEqual([]);
  });

  it(`should answer none for a port nothing listens on`, () => {
    expect(parseNetstatListeners(output, 9999)).toEqual([]);
  });
});

const codeLines = { skipBlankLines: true, skipComments: true };

// Known debt: files over the 800-line limit, each capped at its current size so it cannot grow.
// Lower a cap when a file shrinks; delete the entry when it is under 800.
const longFiles = {
  'src/dev/detachAsync.ts': 921,
  'src/dev/devAsync.ts': 980,
  'src/runtime/reload/reloadAsync.ts': 860,
  'src/smoke/phases.ts': 1081,
  'src/status/statusAsync.ts': 806,
};

// Known debt: files that hold a function over the 100-line limit and have room under 800. The
// disable comment on that function does not stop it from growing, so the file is capped at its
// current size. Lower a cap when a file shrinks; delete the entry when the function is split.
const longFunctionFiles = {
  'src/agents/installAgentAsync.ts': 254,
  'src/dev/easSession.ts': 477,
  'src/followups/smoke.ts': 277,
  'src/plan/decide.ts': 474,
  'src/runtime/discoverDevServer.ts': 194,
};

export default {
  plugins: ['import', 'typescript', 'unicorn', 'oxc'],
  env: {
    node: true,
    vitest: true,
  },
  // Fixture apps are test input, not this package's code.
  ignorePatterns: ['e2e/fixtures/**', 'evals/fixtures/**'],
  rules: {
    'import/no-cycle': 'error',
    'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }],
    // @ref llp/0001-agentic-cli-on-expo-cli.rfc.md — the Expo CLI family runs as a subprocess.
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@expo/cli', '@expo/cli/**'],
            message: 'Run the Expo CLI as a subprocess. Do not import its internals.',
          },
        ],
      },
    ],
    // Output goes through src/log.ts, which tracks stdout for the --json envelope.
    'no-console': 'error',
    'max-lines': ['error', { max: 800, ...codeLines }],
    'max-lines-per-function': ['error', { max: 100, ...codeLines }],
    'max-depth': ['error', 4],
  },
  overrides: [
    {
      files: ['src/log.ts', '**/__tests__/**', 'e2e/**', 'e2e-live/**', 'evals/**', 'scripts/**'],
      rules: { 'no-console': 'off' },
    },
    {
      // Tests are table-driven and long by design; size limits apply to shipped code. Nothing
      // loads, compiles or tests `src/deferred/`, so its size does not matter either.
      files: [
        '**/__tests__/**',
        'e2e/**',
        'e2e-live/**',
        'evals/**',
        'scripts/**',
        'src/deferred/**',
      ],
      rules: { 'max-lines': 'off', 'max-lines-per-function': 'off', 'max-depth': 'off' },
    },
    ...Object.entries({ ...longFiles, ...longFunctionFiles }).map(([file, max]) => ({
      files: [file],
      rules: { 'max-lines': ['error', { max, ...codeLines }] },
    })),
  ],
};

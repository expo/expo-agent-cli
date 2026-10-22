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
    'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
    'max-depth': ['error', 4],
  },
  overrides: [
    {
      files: ['src/log.ts', '**/__tests__/**', 'e2e/**', 'e2e-live/**', 'evals/**', 'scripts/**'],
      rules: { 'no-console': 'off' },
    },
    {
      // Tests are table-driven and long by design; size limits apply to shipped code.
      files: ['**/__tests__/**', 'e2e/**', 'e2e-live/**', 'evals/**', 'scripts/**'],
      rules: { 'max-lines': 'off', 'max-lines-per-function': 'off', 'max-depth': 'off' },
    },
  ],
};

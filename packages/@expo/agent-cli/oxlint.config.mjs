export default {
  plugins: ['import', 'typescript', 'unicorn', 'oxc'],
  env: {
    node: true,
    vitest: true,
  },
  rules: {
    'import/no-cycle': 'error',
  },
};

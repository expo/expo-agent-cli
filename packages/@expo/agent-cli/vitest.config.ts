import { defineConfig, type Plugin } from 'vitest/config';

/**
 * Jest's babel transform turned relative `require('./x')` into something Node could load.
 * Vite leaves those as `createRequire(import.meta.url)('./x')`, and Node then looks for
 * `./x.js` next to the TypeScript source. Hoist them to ESM imports so the same lazy
 * `require('../plan/resolveAsync')` pattern the CLI uses still resolves under Vitest.
 */
function hoistRelativeRequires(): Plugin {
  return {
    name: 'hoist-relative-requires',
    enforce: 'pre',
    transform(code, id) {
      if (id.includes('node_modules') || !id.endsWith('.ts')) {
        return null;
      }
      if (!id.includes('/packages/@expo/agent-cli/src/')) {
        return null;
      }
      if (!/\brequire\s*\(/.test(code)) {
        return null;
      }

      const imports: string[] = [];
      let index = 0;
      const next = code.replace(/\brequire\((['"`])(\.[^'"`]+)\1\)/g, (_match, _quote, spec) => {
        const name = `__cjsreq_${index++}`;
        imports.push(`import * as ${name} from ${JSON.stringify(spec)};`);
        // JSON modules are `{ default: data }`. Named `const { x } = require('./m')` is the
        // usual pattern — do not read `.default` there, because a `vi.mock` factory that
        // returns named exports throws if anything touches a missing default.
        if (typeof spec === 'string' && spec.endsWith('.json')) {
          return `(${name}.default ?? ${name})`;
        }
        return name;
      });
      if (!imports.length) {
        return null;
      }
      return {
        code: `${imports.join('\n')}\n${next}`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [hoistRelativeRequires()],
  test: {
    name: '@expo/agent-cli',
    environment: 'node',
    globals: true,
    clearMocks: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/__tests__/**/*-test.ts'],
    // `src/deferred/` is the v1 narrowing's reference shelf (llp/0016): code no registry entry loads,
    // with the suites that covered it. They assert against a surface this CLI no longer has, so
    // running them would fail on the deferral itself rather than on a regression.
    exclude: ['**/node_modules/**', 'src/deferred/**'],
    pool: 'forks',
    // `bun run` sets these, and `renderForInvoker` would rewrite every `npx @expo/agent-cli`
    // suggestion to `bunx`. Unit tests pin the written `npx` form unless they set a Bun agent.
    env: {
      npm_config_user_agent: '',
      npm_execpath: '',
      NO_COLOR: '',
    },
  },
});

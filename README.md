# expo-agent-cli

Monorepo for Expo's agent CLI.

## Packages

- [`@expo/agent-cli`](./packages/@expo/agent-cli) — the agent-native CLI
- [`expo-agent-cli`](./packages/expo-agent-cli) — npm alias for [`@expo/agent-cli`](https://www.npmjs.com/package/@expo/agent-cli)

## Development

CI uses Bun 1.3.14 and Node.js 24. From the repository root:

```sh
bun install --frozen-lockfile
bun run check
```

`check` verifies formatting, CLI types and lint, and the repository, alias, and CLI unit tests.
It does not build the CLI. For process-level coverage, run `bun run test:e2e`; it builds first.
Both commands are model-free. Live device tests and model evals have separate prerequisites in
the [live-test guide](packages/@expo/agent-cli/e2e-live/README.md) and
[eval guide](packages/@expo/agent-cli/evals/README.md).

For a focused change:

```sh
bun run test:cli -- src/impact/__tests__/classify-test.ts
bun run test:e2e -- help-test
bun run format README.md
```

`bun run test` runs both test runners; bare `bun test` does not run the supported combined suite.
`bun run test:repo` runs only the release-script and alias-launcher tests. `oxfmt` owns formatting
for the whole repository through `.oxfmtrc.json`.

## Finding the right code

Read the [CLI package guide](packages/@expo/agent-cli/AGENTS.md) before editing.
The [design index](packages/@expo/agent-cli/llp/0000-expo-monorepo.explainer.md) links
the subsystem contracts; follow the `@ref llp/...` comments in code for the relevant decision.

| Working on                      | Start here                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Command routing, flags, or help | [`src/cli.ts`](packages/@expo/agent-cli/src/cli.ts), [`src/commandRegistry.ts`](packages/@expo/agent-cli/src/commandRegistry.ts) |
| CLI behavior                    | The command's directory under [`src/`](packages/@expo/agent-cli/src), with tests in `__tests__/`                                 |
| Process boundaries              | [`e2e/`](packages/@expo/agent-cli/e2e), which runs the built CLI against fixtures and subprocess stubs                           |
| npm alias                       | [`packages/expo-agent-cli/src/`](packages/expo-agent-cli/src); run `bun run bundle` after edits                                  |
| Releases or CI                  | [`scripts/`](scripts) and [`.github/workflows/`](.github/workflows)                                                              |

`src/deferred/` is reference material outside the shipped command surface.

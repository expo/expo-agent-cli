# expo-agent-cli

Monorepo for Expo's agent CLI.

## Packages

- [`@expo/agent-cli`](./packages/@expo/agent-cli) — the agent-native CLI
- [`expo-agent-cli`](./packages/expo-agent-cli) — npm alias for [`@expo/agent-cli`](https://www.npmjs.com/package/@expo/agent-cli)

## Development

```sh
bun install
bun test
bun run format
bun run --filter @expo/agent-cli build
```

`oxfmt` formats the whole repo from `.oxfmtrc.json`. CI fails on `bun run format:check`.

# expo-agent-cli

npm alias for [`@expo/agent-cli`](https://www.npmjs.com/package/@expo/agent-cli).

`bunx expo-agent-cli@2.0.0` runs `@expo/agent-cli@2.0.0`. If that version is not on npm, the newest `@expo/agent-cli` at or below it is used. Prefer `npx @expo/agent-cli` in docs, help, and `Try:` lines.

This package has no dependency on `@expo/agent-cli`. Publishing `@expo/agent-cli` also publishes this alias at the same version and dist-tag. Alias-only patches may ship at a newer patch version without a matching `@expo/agent-cli`.

Versions before 1.0.0 were an unofficial Expo docs CLI. 1.0.0 is Expo's alias. A `^0.6` install stays on the old CLI.

## Publishing

GitHub Actions publishes this package with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers). Do not add an npm token to the repo.

Configure the trusted publisher once on npmjs.com (package Settings → Trusted Publisher → GitHub Actions):

- Organization or user: `expo`
- Repository: `expo-agent-cli`
- Workflow filename: `publish.yml`
- Allowed actions: `npm publish`

The script needs a clean git checkout and the [GitHub CLI](https://cli.github.com/). It bumps `package.json` to match `@expo/agent-cli`, then commits, pushes, and dispatches the workflow:

```sh
bun scripts/publish.ts
bun scripts/publish.ts --tag next
bun scripts/publish.ts 2.1.0 --tag beta
bun scripts/publish.ts --dry-run
```

Omit the version to use `@expo/agent-cli` on that dist-tag. The script will not overwrite a version that is already on npm.

After the first trusted publish works, set Publishing access to "Require two-factor authentication and disallow tokens".

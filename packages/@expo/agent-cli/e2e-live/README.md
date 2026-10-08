# Device bindings and two worktrees

Each worktree has its own simulator or emulator binding. Local `dev --ios` runs use
`--device "$AGENT_CLI_LIVE_UDID"` when that variable is set; otherwise `dev` creates a
simulator for the worktree. Explicit devices are never shut down or deleted by cleanup.
The live runner uses `dev:stop --release` when cleaning up its servers.

To exercise isolation manually, open two checkouts and run the following in each, using
8082 for the second checkout:

```sh
npx expo-agent-cli dev --ios --detach --wait-ready --port 8081
npx expo-agent-cli status --json
```

The `binding` arrays should name different devices. In the first checkout, run
`npx expo-agent-cli dev:stop`, then start it again: it should reuse its simulator. Run
`npx expo-agent-cli dev:stop --release --json` in each checkout to park the simulators
(or end spawned Android instances). For explicit selection, assign a different simulator
UDID to each worktree; naming the other worktree's device must refuse.

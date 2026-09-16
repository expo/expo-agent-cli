# 0003: Knowledge tools and skills

**Type:** RFC
**Status:** Active
**Systems:** `src/skills/`; SDK packages in `packages/`
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-20
**Revised:** 2026-09-16
**Related:** [[0001-agentic-cli-on-expo-cli]]

## Summary

The distribution channel for Expo knowledge: skills shipped with the modules themselves.

## Skills shipped from Expo modules

SDK packages carry their own skill covering usage, pitfalls, and config-plugin notes. Installing a package then teaches the driving agent automatically. [confirmed, Kudo seed, 2026-08-18]

Discovery is a directory convention, `skills/*/SKILL.md`, found via autolinking, not a `package.json` field. Scope is co-located module skills (for example `expo-sqlite/skills/`). Module synchronization remains scoped to package-provided skills. `agents:setup` additionally installs official Expo plugins or `expo/skills` through their own installers; those files stay outside module link ownership. [confirmed, Kudo, 2026-09-08; [[0006-agent-native-cli-surface]]]

The code lives in this package, not in `@expo/cli`. Four proof-of-concept PRs against `@expo/cli` (#48592, #48972, #48973, #49018) stay unmerged. The code was copied here. [confirmed, Kudo, 2026-08-20]

`@expo/agent-cli install` and `@expo/agent-cli start` wrap `expo install` and `expo start` as subprocesses and run skill sync around them. The `--no-agent-skills` opt-out survives. `@expo/cli` gets no hooks.

Commands: `skills:sync`, `skills:list`, `skills:show`, `skills:clean`. Bare `skills` syncs (the group's default action).

Automatic sync calls the shared linker directly, using a saved selection in `.expo/agent-skill-links.json` when present and project/home marker detection otherwise. A fresh `new` → `install expo-sqlite` flow must link the package's skills for detected agents without requiring setup first. Detection is recomputed each run and never persisted; project setup or explicit `skills:sync --agent` flags save the selection. An explicitly empty saved selection remains empty. Explicit sync still prunes stale links for detected agents when the last package skill disappears. [observed; fresh-project failure reported by Kudo, 2026-09-16]

Successful named-package installs sync only those packages without pruning; bare installs and full fixes sync the whole graph. Start and dev schedule full sync three seconds after spawning a dev-server step, cancelled on an early exit. A new detached dev child inherits that hook; reusing an existing server does not rerun it. Smoke syncs only indirectly when it bootstraps that child, with no completion guarantee. Check/plan modes, direct Expo passthrough commands, and project creation do not sync. Automatic sync is best-effort and respects `--no-agent-skills` on install/start/dev. [observed]

## Published package skills

The initial implementation shipped before its producers: ten packages checked at that time had no `skills/*/SKILL.md`. That is no longer the current state. A fresh `default@sdk-58` app installs `expo-sqlite@58.0.3`, which contains `skills/expo-sqlite/SKILL.md` and a `references/` directory. The published CLI discovers and prints that skill during install, but its former saved-selection gate prevented linking in a fresh project. [observed, 2026-09-16]

Packages that ship no skills still produce an empty discovery result. Skills are discovered through autolinking, linked as relative directory symlinks, listed, printed, pruned, and cleaned.

## Skipped, not silent

A skill the sync could not link (a directory the user created holds the name, or two packages claim the same link name) is a `skipped` list, carrying the reason (`occupied` or `duplicate-name`) and, for a name clash, the package that kept the name. A report that lists what a command did and omits what it could not do is a report of a run with nothing left over ([[0021-honest-reports]]).

## Instruction skill index

`agents:setup` includes a Package / Skill / Read table in its `AGENTS.md` managed block. Tell agents to read the relevant skill before using or modifying a listed package. Use the discovered package and skill names, with one row per package skill and relative links to each verified agent-directory `SKILL.md`. Multiple skills per package are supported. A same-named directory is not proof of a package link: require a symlink whose resolved skill file matches the discovered source. This excludes occupied paths, broken links, and losing duplicate names. Escape metadata for Markdown and Claude import syntax rather than treating it as generated instructions. [confirmed intent, Kudo, 2026-09-08; observed verification]

The index has its own markers inside the Expo managed block. Explicit sync, automatic sync, and cleanup refresh only this section after link changes, including an empty result when links disappear. A package-scoped auto-sync uses the full discovery result for the index so other packages' linked skills remain listed. Dry runs never write; an absent file or absent index is not created outside setup. Setup suppresses sync's index refresh because it owns instruction generation and must honor `--no-agents-md`. Plugin and standalone skills remain outside module ownership and this index. [observed]

An older managed block receives the index on the next setup run. Unmatched index markers fail with recovery guidance rather than deleting neighboring content. If setup cannot inspect package skills, its generated section reports that uncertainty instead of claiming there are no links. [observed]

## Testing

Skill discovery is deterministic, so it gets unit tests and fixtures. The four reference PRs already carried unit and e2e tests, and those migrated with the code. The live suite `live-project` is where discovery runs over a real dependency graph rather than a fixture.

## Resolved

[confirmed, Kudo, 2026-08-20]

1. Auto-sync triggers live in `@expo/agent-cli`'s own `install` and `start` commands, which wrap the `expo` equivalents as subprocesses. The `--no-agent-skills` opt-out survives.
2. PRs #48592 through #49018 will not merge. They are proof of concept. The code is copied into `packages/@expo/agent-cli`.

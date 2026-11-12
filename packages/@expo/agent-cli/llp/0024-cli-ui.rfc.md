# 0024: The CLI UI

**Type:** RFC
**Status:** Active
**Systems:** the help template (`src/help/types.ts`, `src/help/format.ts`); the on-ramp (`src/help/onRamp.ts`, `src/help/topics.ts`, `src/help/workflow.ts`, `src/help/index.ts`); the registry's summaries, workflow map and listing (`src/commandRegistry.ts`); the palette (`src/utils/color.ts`); the program's own name (`src/programName.ts`); the launcher (`src/cli.ts`); the follow-up block (`src/followups/format.ts`); the status report (`src/status/format.ts`); the template lint (`src/help/__tests__/template-test.ts`)
**Author:** Kudo (drafted with Tuft agent)
**Date:** 2026-08-28
**Revised:** 2026-08-30
**Related:** [[0006-agent-native-cli-surface]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0001-agentic-cli-on-expo-cli]]

## Summary

Three problems, one cause. `@expo/agent-cli --help` listed thirty names and never said which one comes first. Every command's `--help` had a shape of its own. There was no on-ramp for the exit-code bands, the `--json` contract, and the `Try:` convention. The cause is that the help was prose, and prose compiles. Nothing checked it, so nothing held it to a shape.

## The template

One shape for every `npx @expo/agent-cli <command> --help`, in the order a caller needs the answers:

```
  <command>, <one-line summary, from the registry>

  Usage             one $ line
  Options           one entry per flag
  Examples          two to four $ lines, each with what running it gets you
  Typically next    the commands usually run after this one
  JSON (--json)     stdout, stderr, and every top-level key, where --json exists
  Notes             the honest limits and this command's own exit codes

  New here? npx @expo/agent-cli help workflow
```

A help block is data, not a string. `CommandHelp` (`src/help/types.ts`) is the spec. `renderCommandHelp` is the only thing that decides what a block looks like. The registry requires a `help` loader on every entry, so a new command cannot ship with a `--help` its author invented. `src/help/__tests__/template-test.ts` walks the registry, loads every spec, and asserts:

1. the spec names itself, so a block copied from a neighbour cannot document the neighbour;
2. the usage line is this CLI's own invocation, and `-h, --help` is in the options;
3. there are two to four examples, each starting `npx @expo/agent-cli ` and each saying what it gets you;
4. every `Typically next` name resolves against the registry, the same check the suggested-command lint runs over `Try:` lines;
5. the JSON block is present exactly where the options offer `--json`;
6. the rendered block is at most 60 lines, and `Notes` at most 14.

The two caps are the load-bearing part. `Notes` is the only section with no shape of its own, so it is where a wall of prose grows back. The cap is what sends the rationale to the `workflow` topic and to the LLPs instead.

The keys a help block names are every key the `--json` object has ([[0006-agent-native-cli-surface]] §Output contract).

The examples are also checked by the existing suggested-command sweep (`src/lint/`), which reads every `npx @expo/agent-cli …` string literal in `src/` and resolves it. Write examples as literals rather than as a table.

One summary, one place. The one-line summary lives on the registry entry, not in the `CommandHelp`. The top-level listing prints it without loading twenty command modules, and the head of that command's own help prints the same string. A unit test caps it at the width of its column.

## The workflow map

`help workflow` says what to run, in order. `--help` does not repeat the map. It points at the topic, so the two screens cannot disagree.

```
  What to run, in order
       Before you start
    1  Check the project
    2  Start the app
    3  Edit and reload
    4  Verify before you're done
    5  Deploy
```

Each step lists its commands, one line each, with what the command gets you.

- The titles are plain phrases, never labels. If a title needs a legend, it is the wrong title.
- `Before you start` has no number and comes first. It runs once per user or project, not once per change, and `agents:setup` takes effect only in an agent session started after it.
- The map is data, not text. Every command in it must resolve against the registry, so a rename cannot leave the map stale.

Tests: `src/__tests__/commandRegistry-test.ts` pins the titles and resolves every command; `e2e/__tests__/help-test.ts` pins their order.

The `--help` listing keeps its sections: one line per command, the summary in a column, and at most one short note per section. A listing is for finding the command.

## The on-ramp

`help workflow` is one screen for an agent that has never seen this CLI: the map, which commands read and which act, the exit-code bands, the `--json` contract, and the recovery lines. Three places point at it: the top-level screen, the foot of every help block, and the AGENTS.md block that `agents:setup` writes. An agent reads AGENTS.md before it runs any command.

A topic is a positional argument, not a flag, as in `git help workflows`. `help <name>` looks up topics first, then commands, so a command's help has one source: its own `--help`. A wrong spelling such as `help:workflow` gets a `Try:` line with the right one.

## Colors are for humans

A small semantic palette (`src/utils/color.ts`), four roles: section heads, command names, ok, fail, plus dim for asides. Nothing else gets a colour.

It is off in three situations, decided once by the launcher before any command builds a string:

- `--json`. A run whose stdout is a JSON object must carry no escape sequence into it, even when a person is watching. Chalk's own detection says "a TTY, colour is fine". The caller's `JSON.parse` disagrees.
- Not a TTY. Chalk already does this. The launcher states it anyway, because the rule is the point and not the library's default.
- `NO_COLOR`, set and non-empty. Chalk 4's `supports-color` does not implement it, and it is the one switch a user has for saying "not here".

Never colour a value an agent parses. Labels, heads, and command names take colour. The values beside them do not. An agent reads `--json` anyway, where there is no colour at all.

The `status` report uses the same three roles as a help block's `Typically next` for its `Suggested next:` block. They stay different sections: one is computed from what just happened ([[0009-smart-followups]]), the other is the path most callers take. A detail every platform shares is said once, under the rows it explains.

## The program names itself

Program output never hardcodes the program's name. A line that names this CLI reads it from `package.json`, through `src/programName.ts`, at runtime. [confirmed, Kudo, 2026-08-29]

Two constants, because output needs two forms:

- `PROGRAM_NAME`: the name on its own, for a sentence about the program.
- `PROGRAM_PREFIX`: `npx <name>`, the head of every line the reader is meant to run. `npx` rather than the declared bin, because that is what works without an install.

At runtime, not at build time. `import { name } from '../package.json'` is inlined by ncc, so the bundle would answer with whatever the build machine was called, and every in-process test would still pass. The resolution is a walk up from the module's own directory to the nearest `package.json` that has a `name`. An unreadable installation falls back to the published name and says nothing: help that crashes over its own banner is worse than help that prints a stale name.

The acceptance test copies the built package out of the tree, edits `name` in the copy's `package.json` after the build, and asserts that `-h`, one command's help, the workflow topic, and a failing command's `Try:` line all carry the new name. (`e2e/__tests__/program-name-test.ts`)

What does not follow the name, and why each one is a constant instead:

- Follow-up ids and JSONL event names. These are keys a driving agent branches on, a contract per [[0006-agent-native-cli-surface]] §Output contract.
- The files under `.expo/` and the `AGENTS.md` block markers. They are read by the next run, which may be a different version. A rename would orphan the record rather than migrate it.
- The git identity of a snapshot commit (`expo-agent-cli`). One tool is one author across a project's history.
- The declared `bin` name. It exists because `npx <package>` needs a declared bin, and it is named in no help text ([[0001-agentic-cli-on-expo-cli]] §Naming).

The suggested-command lint reads the same module. `src/lint/commandMentions.ts` substitutes the two known interpolations back to the values the CLI will print.

## What this does not do

- It does not version the help. The `--json` keys are the contract. The help text is documentation of it and may be reworded.
- It does not add `--json` to `help`. The on-ramp is prose meant to be read.
- It ships one topic. The mechanism takes more. Splitting the on-ramp before anybody has asked would be three screens where one is being read.
- It does not touch the group listing's shape beyond the palette and a pointer at the on-ramp.

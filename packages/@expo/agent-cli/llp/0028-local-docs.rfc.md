# 0028: Local Expo docs — `docs:sync` and `docs:search`

**Type:** RFC
**Status:** Draft
**Systems:** the docs group (`src/docs/index.ts`); the bundle format and unpack safety (`src/docs/bundle.ts`); the local cache, its lock and its swap (`src/docs/cache.ts`); the download (`src/docs/sync.ts`); SDK version selection (`src/docs/version.ts`); ranking (`src/docs/search.ts`); the follow-up (`src/followups/docs.ts`); the Expo home directory (`src/utils/expoHome.ts`); the `AGENTS.md` block (`src/agents/content.ts`)
**Author:** Vojtech Novak (drafted with Claude agent)
**Date:** 2026-09-30
**Related:** [[0003-knowledge-tools-and-skills]], [[0006-agent-native-cli-surface]], [[0009-smart-followups]], [[0010-agent-conventions]], [[0017-deferred-commands]]

## Summary

Agents work best when docs are local files they can grep. Today an agent fetches docs.expo.dev pages one at a time.

`docs:sync` downloads the full Markdown of the Expo docs, versioned by SDK, and unpacks it to plain `.md` files. `docs:search` ranks those files for a query. Agents read the matching files with their own tools.

## Decisions

**Plain `.md` files on disk, not SQLite FTS.** Agents use their own grep and read tools on files. At about 10 MB, an in-process JS scan is fast enough.

**One gzipped JSONL file per docs version.** `zlib` reads it. The CLI needs no tar parser and no new dependency.

Hosted files:

```
index.json
docs-shared.jsonl.gz
docs-v54.0.0.jsonl.gz … docs-v58.0.0.jsonl.gz
```

"Shared" means the pages outside `versions/`. The name "unversioned" is already used in expo/docs for the next SDK, so this document does not use it.

`index.json`, format `1`:

```json
{
  "format": 1,
  "generatedAt": "2026-09-30T12:00:00Z",
  "latest": "v57.0.0",
  "beta": "v58.0.0",
  "bundles": {
    "shared": { "file": "docs-shared.jsonl.gz", "sha256": "…", "pages": 475 },
    "v57.0.0": { "file": "docs-v57.0.0.jsonl.gz", "sha256": "…", "pages": 246 }
  }
}
```

A bundle line is `{ "path": "versions/v57.0.0/sdk/camera", "title": "Camera", "content": "<markdown>" }`. `path` is the site path, so `https://docs.expo.dev/<path>.md` is the page URL. There is no `latest` bundle: `index.json` maps `latest` to a concrete version. An unknown `format` is rejected, so a later format cannot be misread.

**Change detection by `sha256` in `index.json`.** It works the same on any static host. `index.json` is fetched with `cache: 'no-store'`. The digest of the downloaded bytes is checked before anything is unpacked.

**Base URL.** `DEFAULT_DOCS_BUNDLE_URL` is `https://docs.expo.dev/static/agents`. `AGENT_CLI_DOCS_URL` overrides it. Until the docs build publishes the bundles there, that `index.json` is HTTP 404, and a sync fails with `DOCS_UNAVAILABLE`, which names the variable. So this CLI can ship first, and the commands start to work when the docs deploy, with no new release. A temporary host for testing is the `docs-bundle-poc` release of `vonovak/expo-video-tests`. The CLI always fetches the base URL, follows redirects, ignores the content type, and never stores a redirect target: a signed release-asset URL expires within an hour.

## Local cache

The directory is `$AGENT_CLI_DOCS_DIR`, else `<Expo home>/agent-cli/docs`. The Expo home follows the rules the `expo` CLI family uses (`src/utils/expoHome.ts`), so it is usually `~/.expo`.

```
guides/overview.md
eas/...
index.md                          (the home page)
versions/v57.0.0/sdk/camera.md
versions/latest -> v57.0.0        (symlink, junction on Windows)
manifest.json
.lock
```

The cache root mirrors site paths. A link URL without `https://docs.expo.dev/` is the file path. The `versions/latest` link resolves the `versions/latest/...` links inside shared pages. The link exists only when the latest version is in the cache, because a dangling link is a directory an agent cannot read.

`manifest.json` is `{ baseUrl, latest, syncedAt, bundles: { [name]: { sha256, pages } } }`. It is written after each bundle, so a partial sync is recorded correctly.

### Unpack safety

Every `path` is validated before anything is written:

- Absolute paths, `..` segments and backslashes are rejected. A path must match `^[A-Za-z0-9][A-Za-z0-9._/-]*$`.
- The resolved file must stay inside the bundle's target directory.
- A version bundle must use its own `versions/<v>/` prefix. The shared bundle must not use `versions/`.
- A path that occurs twice in one bundle is rejected.

### Swap

Each bundle is unpacked into `.tmp-<pid>/`. Then one top-level entry at a time is swapped: the old entry is renamed to `.old-<pid>/<name>`, the new entry is renamed into place, and the old copy is deleted. A rename onto a non-empty directory fails, so one rename is not enough.

- A version bundle has one top-level entry: `versions/<v>`.
- The shared bundle has many: `guides`, `eas`, `router`, the home page `index.md`, and more. Each entry is always complete. During a sync some can be new and some still old. That is acceptable.
- Top-level entries that the new shared bundle no longer has are deleted. The shared swap never touches `versions/`, `manifest.json` or dot-files.
- A failure while unpacking leaves the old cache as it was. A killed run leaves a `.tmp-*` or `.old-*` directory behind, and the next run that holds the lock deletes it.

### Concurrency

`.lock` is taken with an exclusive create, and it holds the process ID of its holder. A lock whose process has exited is replaced at once: a sync stopped with Ctrl-C, or killed by a closed pipe, releases nothing [observed — a sync piped into a failing `jq` left its lock, and the next sync waited]. A lock older than ten minutes is stale and is replaced too, which covers a holder on another machine that shares the cache directory. A second run waits, then reads `manifest.json` again. It then usually has nothing to download, because the digests match.

## SDK version selection

One result with three cases (`src/docs/version.ts` §SdkSelection):

1. `explicit`: `--sdk <N>`. When there is no bundle for it, the run fails with `DOCS_SDK_UNAVAILABLE` and lists the versions that exist.
2. `project`: the installed SDK of the project at or above the current directory (`findUpProjectRootOrCwd`, `readSdkVersionAsync`, `sdkMajor`). `docs` also works outside a project.
3. `latest`: `latest` from `index.json`. It is also the fallback for a canary or an unknown major. The reason is printed on stderr.

## Commands

For agents, grep over the synced files is the main path. `docs:search` adds ranking, the SDK version scope and an automatic sync, and it serves humans too. The `docs:sync` help and output say that agents can grep the printed directories.

The `docs` group has no default action. Bare `docs` prints the group listing. It is in the `Learn` help section.

**`docs:sync [--sdk N] [--force] [--json] [--no-followups]`** fetches `index.json`, then downloads `shared` and the chosen version when the digest differs from the manifest. The human output ends with two directories: the cache root, and `versions/<v>` of the chosen SDK. JSON keys: `dir, sdkDir, sdk, latest, baseUrl, bundles, followups`. The follow-up is a first `docs:search`.

**`docs:search <query> [--regex] [--sdk N] [--limit 20] [--json] [--no-followups]`**:

- It syncs when the bundles it needs are missing, unless `EXPO_OFFLINE` is set. Offline with nothing cached, it fails with `DOCS_NOT_SYNCED` and names `docs:sync`.
- When the cache is older than seven days, it searches the current copy and starts a background sync. When automatic syncs are off, it warns on stderr instead.
- Scope: everything outside `versions/`, plus `versions/<chosen>/`. It never descends through `versions/latest`.
- Default mode: case-insensitive terms that must all be on the page. The frontmatter is not body text.
- Score, highest weight first: title, path slug (`sdk/camera`), headings, body.
- `line` is the first line with the highest-weight matching term. `heading` is the nearest `##` or `###` at or above it.
- `--regex`: a case-insensitive, line-level grep.
- Each hit: `{ path, file, url, title, heading, line, snippet }`. `file` is absolute, so an agent opens it at `line`.
- Human output: `title  file:line`, then one snippet line.
- JSON keys: `dir, sdk, query, hits, followups`. `followups` is empty today: the next step is to read a file.

## Automatic sync

The docs must exist before an agent needs them, and they must follow the project's SDK. Four triggers sync without a `docs:sync` call. `src/docs/autoSync.ts` holds all of them.

| Trigger        | How                                                                                 | Report                   |
| -------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `agents:setup` | In-process, after the `AGENTS.md` block. `--no-docs` skips it.                      | `docs` key, a "Docs" row |
| `new`          | In-process, after the `AGENTS.md` block. `--no-docs` skips it.                      | `docs` key, a "Docs" row |
| `install`      | Background, when the cache is in use and lacks the project's SDK after the install. | nothing                  |
| `docs:search`  | Background, when the cache is older than seven days.                                | a stderr line            |

- **A failed sync fails nothing.** Setup and `new` report `{ status: 'failed', reason }` and exit as they would without the sync. A host that publishes no bundles yet (`DOCS_UNAVAILABLE`) is `skipped`, not `failed`: it is the expected state until the docs deploy.
- **The project's SDK** is the installed `expo`, else the `expo` range in `package.json`. A project made with `new --no-install` has only the range.
- **A background sync** is a detached `docs:sync --sdk <N> --json --no-followups` of this CLI's own entry script. The cache lock keeps it from colliding with another sync.
- **`install` never starts a first sync.** It acts only for a user who already has a manifest, because a download nobody asked for is not part of an install.
- **Off switches.** `AGENT_CLI_NO_DOCS_SYNC` and `EXPO_OFFLINE` turn off every automatic sync. The unit tests and the e2e tier set `AGENT_CLI_NO_DOCS_SYNC`, so no test reaches the network by accident.

## How an agent finds the files

1. **The `AGENTS.md` block.** `agents:setup` writes an "Expo docs" section after "Commands". It has no absolute path, because `AGENTS.md` is committed and home directories differ per machine. It also states the link rule: a docs link `https://docs.expo.dev/<path>.md` is the file `<path>.md` in the docs directory. The pages keep their site links. Rewriting them to local paths waits for an eval that shows agents fetch linked pages from the web despite the rule.
2. **`docs:sync` output.** Text prints the root and `versions/<v>`. JSON has `dir` and `sdkDir`.
3. **`docs:search` hits.** Each hit has an absolute `file`.
4. **A fixed default path.** `~/.expo/agent-cli/docs` does not change, so an agent can reuse it after the first sync.
5. **Top-level help.** `docs` is listed in the `Learn` section.

## Testing

Unit tests cover bundle parsing and every rejected path shape, ranking and the regex mode on in-memory pages, version selection, and the swap and lock against a real temporary directory. The sync tests use a mocked `fetch`: first sync, unchanged digest, changed digest, digest mismatch, missing version, a failure mid-unpack, and two concurrent syncs that download once.

The e2e tier serves a fixture `index.json` and small bundles from a local HTTP server, and runs the built CLI with `AGENT_CLI_DOCS_URL` and `AGENT_CLI_DOCS_DIR`. The automatic-sync tests turn `AGENT_CLI_NO_DOCS_SYNC` off for one run: setup syncs the fixture's SDK, `--no-docs` downloads nothing, a failed sync leaves setup successful, and a stale search refreshes the manifest in the background.

The bundle producer is a script in expo/docs, outside this package.

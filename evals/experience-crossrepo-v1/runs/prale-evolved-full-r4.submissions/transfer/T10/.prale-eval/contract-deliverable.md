# Contract: traversal / encoded-separator fixture for generated-file paths

Task `T10` — repository `wattclaw`, mode `contract`.

Request: *contract a new traversal/encoded-separator fixture: verify unsafe paths are rejected
and valid generated paths remain inside the intended root.*

## 1. Contract under test

The generated-file download route (`GET /api/chat/generated-file`, `server/handlers/files.js`)
turns a user-supplied `path` query value into a filesystem target in two stages:

1. **Resolution** — `resolveGeneratedFileCandidatePath(workspaceReal, requestedPath)`
   (`server/utils/generated-file-path.js:1-15`) is a *pure normalizer*:

   | input shape | output `pathMode` | output `candidatePath` |
   | --- | --- | --- |
   | already starts with the workpace root | `workspace-absolute` | the request unchanged |
   | starts with `/` | `workspace-root-relative` | `${workspace}/` + request without leading slashes |
   | anything else | `workspace-relative` | `${workspace}/` + request |

   It strips trailing slashes from the workspace (line 2), rewrites backslash *encoded
   separators* to `/` (line 3), and **never rejects, clamps or collapses `..` segments**. It is
   therefore not a containment decision on its own.

2. **Containment** — the route realpaths the candidate and rejects it unless
   `path.posix.relative(workspaceReal, targetReal)` is non-empty, not `..`, does not start with
   `../` and is not absolute (`server/handlers/files.js:134-138`). Additional gates reject the
   request shape (NUL byte / empty, `files.js:89`) and denied names/segments
   (`.env`, `.env.*`, `.git`, `.openclaw`, agent dotfiles — `files.js:39-45`).

The contract this fixture pins:

> **Unsafe requests (traversal, encoded-separator traversal, symlink escape, absolute path
> outside the root, denied names) must be rejected; valid generated paths (relative,
> root-relative, workspace-absolute) must resolve to a target strictly inside the intended
> workspace root.**

## 2. Executable demo

`server/utils/generated-file-path.traversal-fixture.mjs` — runnable with the Node standard
library only (no `vitest`, no `node_modules`, no network):

```bash
node server/utils/generated-file-path.traversal-fixture.mjs
```

What it does:

* builds a throw-away tree under the git-ignored `<repo>/.tmp/` (workspace root
  `.tmp/…/workspace/agent-root`, a real `downloads/report.pdf`, an `.env`, a sibling
  `outside/secret.txt` that must stay unreachable, and an `escape-link` symlink that is
  lexically inside the root but really points outside it), and removes it again in a `finally`;
* mirrors the route's gates (`decide()` at `…traversal-fixture.mjs:98-113`): resolve →
  `realpath` (null ⇒ `rejected:not-found`) → `posix.relative` containment (⇒ `rejected:escape`)
  → name gate (⇒ `rejected:denied-name`) → otherwise `accepted`;
* asserts every **unsafe** request (literal, backslash-encoded, root-relative, nested,
  Express-decoded percent-encoded traversal, symlink escape, absolute-outside path, missing
  target, denied `.env`) is rejected for the expected reason;
* asserts every **valid** generated path is accepted, keeps its documented `pathMode`, and
  realpaths to a target strictly beneath `workspaceReal`;
* asserts the normalizer properties that make the contract necessary (`..` survives resolution;
  backslash → `/`; trailing slash stripped; NUL byte fails the request-shape gate).

Observed result (exit code `0`):

```
CONTRACT FIXTURE PASSED: 21/21 checks
```

## 3. Normalized operation result

| request (`path` query value) | `pathMode` | decision | reason |
| --- | --- | --- | --- |
| `downloads/report.pdf` | workspace-relative | accepted | inside root |
| `downloads\report.pdf` (encoded separator) | workspace-relative | accepted | encoded separator normalized to `/` |
| `/downloads/report.pdf` | workspace-root-relative | accepted | inside root |
| `<workspace>/downloads/report.pdf` | workspace-absolute | accepted | inside root |
| `<workspace>/downloads/../downloads/report.pdf` | workspace-absolute | accepted | normalizes back inside root |
| `../../outside/secret.txt` | workspace-relative | rejected:escape | `posix.relative` starts with `../` |
| `..\..\outside\secret.txt` | workspace-relative | rejected:escape | backslashes rewritten to `/`, then escape |
| `/../../outside/secret.txt` | workspace-root-relative | rejected:escape | leading slash re-rooted, then escape |
| `downloads/../../../outside/secret.txt` | workspace-relative | rejected:escape | nested escape |
| `/downloads/../../../outside/secret.txt` | workspace-root-relative | rejected:escape | nested escape |
| `decodeURIComponent('..%2F..%2Foutside%2Fsecret.txt')` | workspace-relative | rejected:escape | percent-decoding happens before the resolver |
| `escape-link/secret.txt` (symlink) | workspace-relative | rejected:escape | realpath lands outside the root |
| `/abs/path/outside/secret.txt` | workspace-relative | rejected:not-found | absolute-outside request is re-rooted under the workspace |
| `downloads/missing.pdf` | workspace-relative | rejected:not-found | `realpath` fails |
| `downloads/../.env` | workspace-relative | rejected:denied-name | name gate (`.env`) |
| `<path with NUL byte>` | — | rejected:invalid-request | request-shape gate before resolution |

## 4. Repository test suite

The same expectations are pinned in the repo's own runner
(`server/utils/generated-file-path.test.js`): a `containment()` helper (`:8-12`) applies the
route's `posix.relative` rule to the resolver output, and five added cases cover encoded
separators, relative/root-relative traversal, and the documented valid path modes. They run
under the project's normal tooling:

```bash
npx vitest run server/utils/generated-file-path.test.js
```

## 5. Validation performed here

```bash
node server/utils/generated-file-path.traversal-fixture.mjs
node --check server/utils/generated-file-path.js \
  && node --check server/utils/generated-file-path.test.js \
  && node --check server/utils/generated-file-path.traversal-fixture.mjs
node --input-type=module -e "<replay of the added vitest expectations against the real module>"
node -e "<result.json schema / symbol-range / claim-coverage assertions>"
```

All passed (`21/21` fixture checks, exit code `0`).

**Limitation (recorded):** `node_modules` is absent in this checkout, so the project test
runner (`vitest`) could not be executed and no dependency was installed. The added
`generated-file-path.test.js` cases were therefore verified by replaying their expectations
against the real module with plain `node` (equivalent for this dependency-free module), and the
standalone fixture is the executable end-to-end evidence. This is substitute evidence of
limited strength, not a run of the official suite.

No task metadata, hidden-oracle file, package lock or git configuration was modified; only
`server/utils/generated-file-path.traversal-fixture.mjs` (new),
`server/utils/generated-file-path.test.js` (added cases) and `.prale-eval/` were touched.

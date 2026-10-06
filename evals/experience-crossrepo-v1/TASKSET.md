# Cross-repository experience evaluation v1

## Goal

Measure whether a coding agent turns work across real repositories into durable,
useful experience. This is not a benchmark of bug-fixing alone. It includes
repository investigation, a constrained operation, a small implementation,
and a contract test or demo.

The corpus has 30 learning tasks and 30 blinded transfer tasks. A transfer task
is never the same change, test, or answer as its paired learning task. It shares
an *experience kernel*: a reusable method such as tracing configuration
precedence, preserving an error envelope, or proving queue idempotency.

Repositories, frozen before a run:

| Id | Repository | Primary stack |
|---|---|---|
| `pi` | `/root/vibe/CoLe/pi` | TypeScript monorepo |
| `aider` | `/root/vibe/CoLe/aider/aider` | Python coding agent |
| `tdam` | `/root/vibe/deploy/real-wattclaw/TencentDB-Agent-Memory` | TypeScript services/plugins |
| `wattclaw` | `/root/vibe/deploy/real-wattclaw/wattclaw` | Vue + Node.js |

The runner must record the exact commit of every repository in the capsule
manifest. No task may use network access, a real database, credentials, or a
real deployment.

## Memory and isolation contract

One PRALE database belongs to one benchmark repetition, and all four
repositories use it. This does **not** mean all raw repository facts are
globally visible:

```text
run R
  L1/L2 scope: pi        ┐
  L1/L2 scope: aider     ├── one shared, procedure-only L3
  L1/L2 scope: tdam      ┤
  L1/L2 scope: wattclaw  ┘
```

- L1/L2 keep their normal repository scope. A Pi path, a WattClaw tenant ID,
  or a TencentDB API detail must not be retrieved in another repository.
- L3 is shared and is allowed to contain only reusable procedures: e.g. “make
  precedence explicit with a table-driven test”, “settle durable intent only
  after the effect result is known”, or “assert envelope errors at the HTTP
  boundary”. It must contain no file paths, symbols, code excerpts, secrets,
  commit IDs, or repository names.
- The learning phase uses the production L1 threshold of five user turns. The
  adapter must not set it to one and must not call force-flush to bypass it.
- After learning, run the declared benchmark promotion drain to quiescence,
  audit all resulting L1/L2/L3 records, then stop it. The drain may advance
  delayed L2/L3 jobs for runtime practicality, but it must never force an L1
  job before its five-user-turn threshold. Transfer starts in a new process, a
  clean checkout, and a fresh agent session.
- `L3-audit.json` is a required artifact. A run is invalid if a global record
  contains a repository-specific path, identifier, URL, token-shaped string,
  or source excerpt.

Each task emits only a stage-local artifact under `.prale-eval/result.json`.
The stage workspace is discarded after its hidden oracle runs. That artifact is
captured into L0 during learning but is not copied to transfer workspaces.

## Task modes and oracle conventions

| Mode | Agent deliverable | Hidden oracle |
|---|---|---|
| `explore` | structured answer in `.prale-eval/result.json` | exact facts and evidence paths, with no source modification required |
| `demo` | a small executable/demo plus result JSON | runs against a fixture and checks observable output |
| `contract` | a focused test or assertion plus result JSON | removes/replaces a hidden implementation and verifies the contract catches it |
| `operate` | command output normalized to result JSON | runs only local fixtures/stubs and checks exit/output/state |

All task prompts prohibit changing harness files, fixture oracle files, package
lock files, or git configuration. Implementations are deliberately small: one
module, endpoint adapter, parser branch, or focused test at most.

Non-explore tasks additionally submit complete executable files and fixtures,
with one runnable, workspace-relative Bash command in `validation.command`.
The controller independently replays that command in a copied final workspace,
records full stdout/stderr, exit and timeout status, and preserves replay results
separately. The LLM judge evaluates these records alongside code and the full diff;
non-explore quality cannot pass without completed replay. This is execution
evidence collection, not task-specific behavioral testing. Details and historical
compatibility are specified in `specs/crossrepo-execution-evidence.md`.

## Learning and blinded transfer pairs

`Scope` says what kind of experience should be available in the transfer:
`local` permits same-repository L1/L2 and shared L3; `L3-only` deliberately
switches repositories, so local records cannot legitimately answer it.

| # | Scope | Learning task (Phase A) | Blinded transfer task (Phase B) | Experience kernel |
|---|---|---|---|---|
| 01 | local / pi | **Explore** `packages/coding-agent/src/core`: produce a precedence table for CLI, project, user and default settings, including the evidence symbols. | **Contract** in a different coding-agent setting resolver: add a table-driven assertion that one fixture’s project value wins over user/default but loses to an explicit CLI value. | Trace configuration sources before changing precedence; test the complete ordering, not one branch. |
| 02 | local / pi | **Explore** `packages/coding-agent/src/core/resource-loader.ts`: map the pre-trust and post-trust resource-loading lifecycle. | **Demo** for a fresh extension fixture: show that a project extension is unavailable during bootstrap and becomes available only after an explicit trusted decision. | Security boundary = phase separation; demonstrate both forbidden and allowed phases. |
| 03 | local / pi | **Contract** in `packages/agent/test/harness`: write a minimal test showing that an operation’s effect cannot be observed before durable intent settlement. | **Contract** for a different tool/execution path: verify a failed effect leaves a retryable intent rather than a terminal success. | Durable intent → effect → atomic settlement, with both success and failure observations. |
| 04 | local / pi | **Operate** the JSONL/session test utilities on a supplied tiny fixture and output a lineage report: session ID, branch tip, parent relation and replay result. | **Demo** a separate snapshot/restore fixture and prove its restored branch sees the expected terminal entry but not a sibling branch entry. | Inspect durable state through public/test helpers and assert lineage, not file layout. |
| 05 | local / pi | **Explore** model catalog generation and offline build paths (`packages/ai`, root scripts); report which inputs are generated, hydrated, and safe offline. | **Operate** an offline fixture that intentionally lacks network data; choose and run the narrowest valid local check, reporting why it is offline-safe. | Classify generated versus source artifacts before invoking expensive/networked commands. |
| 06 | local / aider | **Explore** `aider/args.py` and `aider/main.py`: write a structured map from option parsing through validation to runtime configuration. | **Contract** for a different boolean/tri-state option fixture: prove explicit CLI input overrides environment/config input without changing unrelated defaults. | Follow configuration from parser to consumer and test source precedence at the boundary. |
| 07 | local / aider | **Explore** `aider/repomap.py` and `aider/repo.py`: report how repository discovery, ignore rules and map construction are separated. | **Demo** build a code-map from a supplied miniature repository and prove ignored/generated files are absent while one relevant symbol is present. | Separate filesystem discovery, filtering and semantic indexing; use a miniature repo for deterministic verification. |
| 08 | local / aider | **Contract** around `aider/coders/search_replace.py` or edit-block handling: add a focused ambiguous-match failure case. | **Contract** for a distinct newline/whitespace edit fixture: verify an exact edit succeeds once and a non-unique edit fails without partial mutation. | Make editing operations atomic; distinguish “no match”, “one match”, and “ambiguous match”. |
| 09 | local / aider | **Explore** `aider/linter.py`, `aider/run_cmd.py` and their tests: describe timeout, output capture and exit-status handling. | **Operate** a local fake linter that emits stdout, stderr and a nonzero exit; normalize the observed result into the required JSON schema. | Treat command execution as a structured result, preserve stdout/stderr/exit status, never infer success from text. |
| 10 | local / aider | **Demo** the model-info lookup path using a local fixture/cache, including the fallback when metadata is unavailable. | **Contract** for a different local model metadata fixture: assert unknown model handling is explicit and does not silently claim unsupported capabilities. | Prefer conservative capability fallback and test the negative path. |
| 11 | local / tdam | **Explore** `MemoryCore/src` memory write/read flow and identify the client, persistence boundary, and metadata carried with a memory operation. | **Demo** with a local fake HTTP backend: perform one write then one scoped read and verify request order, scope metadata and normalized result. | Capture scope/provenance at the API boundary; test interactions with a fake transport. |
| 12 | local / tdam | **Contract** the v3 SDK HTTP/error path under `sdk/memory-core/typescript/src/v3`: add a fixture for a malformed error envelope. | **Contract** a different metadata or prompt client failure: assert it exposes a typed/normalized failure instead of leaking a raw response shape. | Validate response envelope once at the boundary and preserve a stable typed failure contract. |
| 13 | local / tdam | **Explore** `MemoryKnowledge/src/store/build-queue.ts`, `serial-queue.ts`, and auto-sync scheduling: report ownership, ordering and retry/idempotency points. | **Contract** a separate queue fixture where the same source is submitted twice; prove it creates one effective build and records the expected terminal state. | Queue idempotency requires stable identity plus explicit terminal-state assertions. |
| 14 | local / tdam | **Demo** wiki-ingest helpers (`slug`, frontmatter, chunker) on a small local markdown corpus and output deterministic document IDs/chunk counts. | **Contract** a different corpus containing duplicate headings and malformed frontmatter; prove normalization is deterministic and invalid metadata is handled explicitly. | Normalize untrusted documents before indexing; test deterministic IDs and malformed input. |
| 15 | local / tdam | **Explore** MemoryPanel kernel adapters and request-header middleware; make a request-flow diagram from HTTP route to adapter to envelope. | **Contract** a different panel route with missing/invalid required headers; verify it returns the standard envelope and never calls the downstream fake client. | Authenticate/validate before side effects; assert both rejection and “downstream not called”. |
| 16 | local / wattclaw | **Explore** `server/core/session-sync.js` and `server/core/session-usage-cache.js`: report the ordering and idempotency keys of synchronization. | **Contract** with a distinct duplicate-event fixture: verify replaying one session update cannot double-count usage or emit duplicate state changes. | Build idempotency around a stable event/session key and prove duplicate delivery is safe. |
| 17 | local / wattclaw | **Explore** `server/core/multi-tenant-gateway.js` and request context: identify tenant boundary enforcement and failure behavior. | **Demo** using local fake gateway/config fixtures: show an allowed tenant request reaches the fake backend while a mismatched tenant is rejected before dispatch. | Establish tenant context at ingress and prove isolation before any external effect. |
| 18 | local / wattclaw | **Contract** `server/core/config-queue.js`: cover ordered updates and one rejected configuration action. | **Contract** a different configuration fixture where the first job fails and the next job must still settle deterministically. | Queue settlement must not strand following work after a failure. |
| 19 | local / wattclaw | **Explore** `server/services/wattclaw-project-runtime.js` plus project events; emit a lifecycle/state-transition table. | **Demo** a fresh local project fixture: drive create → activate → stop and assert only legal transitions and emitted events. | Model lifecycle as explicit transitions, test legal and illegal edges separately. |
| 20 | local / wattclaw | **Operate** `server/utils/generated-file-path.js` and attachment utilities on a controlled file fixture; report canonical path and rejection reason for unsafe input. | **Contract** a new traversal/encoded-separator fixture: verify unsafe paths are rejected and valid generated paths remain inside the intended root. | Canonicalize then authorize paths; check containment after normalization. |
| 21 | L3-only, pi → aider | **Learn in pi:** investigate a focused test’s setup/action/assertion structure and produce a minimal contract-test checklist. | **Evaluate in aider:** add a focused test for a distinct command/config behavior using the same setup/action/assertion discipline. | Shrink a broad behavior into a deterministic, independently runnable contract test. |
| 22 | L3-only, aider → wattclaw | **Learn in aider:** operate a stub command that fails with stdout/stderr/exit code and preserve all three fields. | **Evaluate in wattclaw:** normalize a fake backend command/child-process failure into a structured server result without losing diagnostics. | Structured command-result handling transfers across language and process APIs. |
| 23 | L3-only, tdam → pi | **Learn in TencentDB Agent Memory:** trace a request through header validation, route, adapter and response envelope. | **Evaluate in pi:** create a tiny local RPC/command adapter demo whose invalid input is rejected before the fake effect and uses one stable error shape. | Validate at ingress, isolate effects, return a stable envelope. |
| 24 | L3-only, wattclaw → tdam | **Learn in WattClaw:** prove duplicate delivery is harmless for session synchronization. | **Evaluate in MemoryKnowledge:** prove duplicate source/build submission does not create duplicate effective work. | Idempotency = stable dedupe key + terminal-state observation, not merely a boolean guard. |
| 25 | L3-only, pi → wattclaw | **Learn in pi:** distinguish source, generated and hydrated artifacts for an offline build. | **Evaluate in WattClaw:** choose a narrow, offline-safe verification of a frontend/server fixture and explain why it avoids runtime/deployment dependencies. | Before running a command, classify its dependencies and choose the smallest deterministic check. |
| 26 | L3-only, aider → tdam | **Learn in aider:** map option/config precedence from input source to runtime consumer. | **Evaluate in MemoryPanel:** construct a precedence test for instance/panel configuration where explicit request input, config and default conflict. | Make precedence explicit as a table; test every competing source rather than relying on incidental ordering. |
| 27 | L3-only, tdam → wattclaw | **Learn in TencentDB Agent Memory:** normalize markdown/frontmatter input before indexing and reject malformed metadata. | **Evaluate in WattClaw:** add a focused parser/normalizer test for a user-controlled configuration or attachment metadata fixture. | Parse untrusted structured input once, normalize it, and make invalid state non-actionable. |
| 28 | L3-only, wattclaw → aider | **Learn in WattClaw:** derive allowed and forbidden edges from a project lifecycle state machine. | **Evaluate in aider:** write a state-transition test for a distinct session/watch/command lifecycle helper using legal and illegal edges. | State-machine tests should assert transition legality and side effects, not only final output. |
| 29 | L3-only, pi → tdam | **Learn in pi:** model an operation as durable intent → effect → settlement, including failed effect handling. | **Evaluate in MemoryCore:** create a fake client operation test that proves no success state is committed before the fake effect completes and failure remains observable. | Explicit effect boundaries make retry/recovery behavior testable in any service. |
| 30 | L3-only, tdam → aider | **Learn in TencentDB Agent Memory:** create a fake-transport interaction test that checks request order and scope metadata. | **Evaluate in aider:** test a distinct external/model helper with a fake transport, asserting request fields and no hidden network access. | Prefer hermetic fakes; assert interaction contracts and provenance, not only return values. |

## Execution schedule

1. Run learning tasks 01–30 in the listed order. Each is a separate user task
   and fresh workspace; PRALE keeps one run-scoped database. Claude conditions
   receive exactly the same prompts, fixtures and tool policy.
2. Wait for normal durable promotion to produce the eligible records. Reject a
   PRALE run that has fewer than five user-originated archives in any local
   scope with five local learning tasks.
3. Snapshot and hash the PRALE state; run the L3 redaction audit.
4. Materialize a new clean workspace for every blinded transfer task. Do not
   expose the learning task IDs, source diffs, result artifacts or old worktree.
5. Execute transfer tasks 01–30 in a randomized order. Keep the task-to-pair
   mapping hidden from agents and from the public task prompt.
6. Run at least three independent repetitions. The randomization seed, source
   revisions, prompt version, runtime settings and model identifiers belong in
   the result manifest.

## Comparison matrix

The required systems are:

| System | Learning state admitted to transfer |
|---|---|
| PRALE-cold | empty PRALE state |
| PRALE-evolved | run-scoped L1/L2 plus audited shared L3 |
| Claude-fresh | no prior session or saved artifact |
| Claude-resume | raw learning conversation resumed, with a reset clean workspace |

`Claude-resume` is deliberately a strong raw-context control; it must not be
called “memoryless Claude”. An optional Claude-authored handoff-file condition
is useful, but is a separate augmented-memory baseline rather than native
Claude Code.

Primary outcomes are paired transfer pass-rate lift, median successful cost,
median successful wall time, and the rate of invalid/irrelevant memory use.
Report local tasks (01–20) and L3-only tasks (21–30) separately. A claim that
shared L3 helps requires a positive L3-only lift plus a provenance audit showing
that no local source fact crossed repository boundaries.

## Fixture build checklist

For every one of the 60 stages, fixture construction must add:

1. `TASK.md` containing only the stage-local request;
2. local mini-fixture data/stubs where the task needs a process, transport, or
   input corpus;
3. `oracle.py` outside the agent instruction path;
4. an expected result schema and an oracle that permits equivalent valid
   implementations rather than one exact patch;
5. a stage-specific test command with a bounded timeout;
6. a leakage review confirming no task text names its paired task or exposes
   source answer artifacts.

All 60 stages have been materialized against their frozen repository capsules.
Their generated prompts declare the required repository-local evidence, and
their workspace-external oracles enforce the delivery schema and stage-specific
evidence contract. A stage is billable only while its `fixture.json` status is
`ready`.

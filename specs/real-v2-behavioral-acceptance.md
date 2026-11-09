# Real-v2 behavioral acceptance, basic fixture revision 4

This protocol changes evaluation fixtures and acceptance only. It does not
change harness public APIs, persistence, memory promotion or recovery semantics.
The benchmark ID remains `prale-experience-real-v2`; `fixture_revision` and
`oracle_version` are 4 and 3 respectively. Earlier acceptance scores are not directly comparable.

## ADR-001: Execute source behavior and require mutation-sensitive regression

Background: the original 12 stages had only five fault patches and checked for
source substrings. Comments could pass; equivalent repairs could fail. Several
correction tasks did not state the new policy, and existing tests were not run.

Decision: all 12 stages receive nonempty, deterministic mutations generated
from the bundled committed capsule. Every prompt states its observable policy,
target file, delivery schema and executable test command. Fault baselines must
fail the hidden behavioral suite; the original healthy implementation and
semantically equivalent repairs must pass. The hidden suite is external to the
agent workspace. Public support code contains boundary fakes and module loading,
not acceptance assertions or a reference repair.

The Node 24 suite strips types and evaluates complete submitted TypeScript
modules. It does not extract a condition or search for an expected source string.
Node's experimental VM modules flag is required. No npm dependencies, network,
provider credentials or real deployment are required by acceptance.

- Trust: execute the real loader constructor, bootstrap, reload and final
  extension assembly with settings/package/extension-loader fakes. Check both
  initial trust states and both resolver decisions, asynchronous ordering,
  user/CLI preservation, project exclusion/admission, subsequent denial,
  resolver rejection and reload without a resolver.
- Migration: execute real migration functions with Node fs/path against temporary
  directories. Check BOM/plain OAuth, provider fields, API-key fallback and
  precedence, existing-auth preservation, malformed input, POSIX/Windows/UNC
  paths, byte preservation, destination collisions, batch continuation and
  repeated execution.
- Recovery: execute real `recoverToolInvocation` and interruption formatting.
  Check all persisted-policy/current-declaration/cancellation combinations,
  missing tools/policies, checkpoint evidence, clear-before-invoke and
  publish-after-effect-completion. Only checkpoint IO, tool execution and
  publication are replaced with recording fakes. This is a recovery-guard
  contract, not an end-to-end durable-storage/crash-recovery test.

The original injected source is captured outside the workspace before the agent
starts. Its immutable baseline commit ID is also captured by the controller.
The agent must submit `.prale-eval/regression.mjs` and a stage-local result JSON.
Tracked changes outside the target and `.prale-eval/`, out-of-scope new files,
missing/symlinked required delivery and modified public support are rejected.

Acceptance requires all of:

1. Agent process completes successfully, with correctly identified delivery.
2. Hidden behavioral contracts pass against a separate final-workspace copy.
3. Submitted regression exits zero on a separate fixed copy.
4. The same regression fails with a Node assertion when only the target source
   is replaced by the captured original fault in an independent copy. A no-op,
   unconditional failure, syntax/import/runtime error, launch failure or timeout
   cannot satisfy this requirement. Tests must use uncaught `node:assert`
   assertions, rather than a test runner that consumes assertion errors.

Each Node subprocess has a fresh HOME/TMPDIR, a default 15-second timeout,
cleared inherited Node options/credentials, and process-group cleanup. The outer
oracle has the controller's validation timeout (default 60 seconds). The stage
report retains structured behavior/fixed/fault status, exit codes and bounded
stdout/stderr under `oracle_result`; failures do not become acceptance merely
because the agent prints a success message.

Consequences and limits: this proves the submitted source meets the specified
boundary contracts and that a submitted regression distinguishes this stage's
fault. It does not prove arbitrary semantic correctness or that memory caused
the repair. The three themes still reuse the same source functions and are not
three independent variants per theme. The correction stages provide explicit
policy updates, but do not guarantee the agent previously formed a stale memory.
No model-backed warm/cold comparison is claimed by local fixture tests.

The VM loader, fresh directories, process limits and cleared environment are not
an OS security sandbox. Adversarial submissions may forge errors or inspect host
files without external isolation. Use the existing pinned-container/egress
policy for model-facing runs. Do not run concurrent untrusted agents and oracles
in the same writable host namespace.

## Fixture matrix

| Theme | learn | transfer | correction | retransfer |
|---|---|---|---|---|
| Trust | bootstrap trusts project | approval ignored | resolver never consulted | denial treated as approval |
| Migration | OAuth BOM handling removed | Windows separator omitted | collision overwrites destination | collision aborts remaining batch |
| Recovery | either safe flag permits replay | current declaration ignored | all replay prohibited | cancellation ignored |

## Verification

`tests/unit/test_real_experience_behavior.py` executes the shipped capsule's real
source. It checks every healthy/mutated pair, comment-only bypasses, equivalent
repairs, mutation-sensitive submitted regressions, invalid deliveries, subprocess
timeouts, and full materialize → repair → external oracle stage execution for
all three themes. Existing evaluator, adapter and report tests remain required.
Use a new output/state directory for revision-3 model runs.

## ADR-002: Independent advanced multi-module suite (oracle version 4)

Background: revision 3 validates local faults reliably but mostly requires one
source-line repair in one module. It does not establish cross-module consistency.

Decision: add `evals/experience-real-v2/advanced/` without replacing the original
corpus. Twelve stages in three four-stage episodes inject independent regressions
in 2–3 existing production files each. Inputs and behavior requirements are public;
patches, oracle metadata and hidden assertions remain outside the agent workspace.
All sources come from the same frozen capsule. A generated task catalog records
exact paths, source commit, suite ID, fixture revision and oracle version.

The advanced loader links actual target modules together. Fakes are limited to
non-corpus external dependencies, settings storage, resource discovery/extension
execution, checkpoint persistence, progress transport and hook delivery. It does
not replace target settings parsing, text normalization, JSONL reading, resolver,
recovery guard, effect gate or tool execution/finalization with a reference fake.
It exposes the private recovery function without changing its implementation.

Version-4 capture stores all faulty target files outside the agent workspace
before execution. Each stage must change every declared source file. Acceptance
runs hidden behavior, a fixed submitted regression, separate regressions with each
single file restored, and one combined-fault regression. All run in independent
copies. An uncaught Node assertion is required for negative regression evidence;
ordinary runtime failures and timeouts fail acceptance. Each Node call is bounded
to eight seconds; the outer oracle keeps the default 60-second bound. Structured
results identify the suite/task and retain per-file evidence.

Correctness checks use fixed inputs and Promise barriers, including UTF-8 boundary
reads and progress-drain admission/publication ordering. Corpus tests enumerate
all faulty-file subsets, rejecting both complete and partial repairs. Reference
regressions in tests are independently written against the public helper, not
imports of hidden assertions. End-to-end tests materialize the complete shipped
capsule and exercise the external oracle in all three themes. Original version-3
and crossrepo behavior stays supported. No runtime persistence/API changes occur.

Consequences: stronger deterministic coverage and multi-module requirements, at
the cost of additional replay processes and fixture code. This is still a scoped
contract evaluation and not an OS security boundary, complete pi system test,
real crash-recovery experiment, or evidence of model/long-term-memory performance.
Run model experiments with fresh state and output directories; do not pool scores
from the original and advanced suites without distinguishing their manifests.

## ADR-003: Audit fixes and controller-owned scope evidence (advanced revision 2)

Background: targeted counterexamples reproduced false rejections for namespace
imports, unsafe defaults for missing replay policy, shared helper state under
concurrency, assertion misclassification, dropped diagnostic markers, Git-index
scope bypasses, and condition inference from replay directory names. Directory
iteration and missing event/field assertions also weakened determinism/coverage.

Decision: advanced fixture revision 2 captures `baseline.json` outside the agent
workspace before execution. It records actual file hashes, symlink targets, the
baseline commit ID and Git configuration hash. Version-4 scope checks compare
actual filesystem contents and configuration with that manifest, rather than
trusting the agent-controlled Git index. The captured faulty source files remain
separate; oracle arguments are unchanged. Normal agent commits stay supported.

The public helper exposes full builtin namespaces, distinguishes missing/null
policy from default options, uses an independent module graph for each recovery
run, and fixes migration directory enumeration at the fs boundary. Hidden checks
cover 32 replay-policy/declaration/cancellation combinations, actual gate admission,
partial patch inheritance, termination, failure callbacks and strict event presence
and order. The path task explicitly targets absolute POSIX cwd values and embedded
Windows-style separators, not Windows OS emulation.

The common script wrapper identifies genuine Node AssertionError instances,
rejects direct exits and shaped ordinary errors, and appends its marker after
bounded diagnostics. Hidden suites also use that wrapper. Fixed and faulty replay
copies use identical workspace basenames under neutral random parent directories.
These common wrapper/builtin fixes also apply to the original revision-3 fixtures;
version-3 scope validation otherwise retains its existing protocol.

Consequences: audit counterexamples are regression tests, in addition to all
healthy/fault-subset corpus checks and complete capsule execution tests. Earlier
advanced revision-1 results must not be silently pooled with revision 2. This
closes the reproduced bypasses but does not make same-namespace untrusted code a
secure sandbox or prove arbitrary submitted tests are semantically meaningful.
The maintainer-facing construction, task-by-task contracts, audit and limitations
are documented in `evals/experience-real-v2/advanced/CONSTRUCTION_AND_TESTING.md`.

## ADR-003: Audit hardening of acceptance and replay isolation (2026-11-09)

Background: the basic oracle trusted the submitted Git index for scope checks,
reused its hidden-behavior copy for fixed regression replay, and used a timed
sleep to infer asynchronous ordering. Advanced scope fingerprints omitted file
permissions; default trust policies were not independently exercised. Agent
children could survive the launcher and race acceptance. Invalid UTF-8 output
could crash the Node adapter instead of producing a structured result.

Decision: the controller captures an external file/symlink/content/permission
manifest and Git config digest before execution for both suites. Basic oracle 3
requires the sidecar `original-fault.baseline.json`; advanced oracle 4 keeps its
`original-fault/baseline.json` interface. Git status is diagnostic only. Hidden
behavior, repaired regression, and faulty regression each get independent copies.
Use explicit Promise barriers for recovery ordering, independently test default
`always`/`never` policies, kill the agent process group before validation, and
decode Node output as UTF-8 with replacement with stdin closed.

Consequences: basic fixture revision becomes 4; advanced fixture revision becomes
3. Oracle protocol versions remain 3 and 4 respectively. Do not pool scores from
previous revisions. Basic reports now include task ID and fixture revision.
There is no harness runtime/persistence change. These contracts still do not
constitute a production build, crash-recovery proof, semantic proof of submitted
regression intent, or evidence of memory benefit. See the Chinese audit report
at `evals/experience-real-v2/AUDIT_REPORT.md` for affected task families and tests.

## ADR-004: Hidden target prompts and separate solving/promotion accounting

Background: listed file paths reduce localization difficulty. Existing adapter
usage and stage wall time include serial memory promotion, obscuring solving
costs and losing failure usage/timing visibility.

Decision: add opt-in `target_visibility=hidden`, transforming both the workspace
TASK.md and the exact model prompt before baseline capture. Remove stage-specific
production target lists and edit-count instructions; retain incident behavior,
delivery requirements, and the common public loader (identical across stages).
Controller target metadata, faults, scope and hidden behavioral acceptance remain
unchanged. This tests localization with common testing support, not zero-hint
localization. Existing `listed` tasks and historical results remain intact.

PRALE accounting schema 2 reports solving duration/agent usage as primary metrics,
with promotion and end-to-end wall time separate. Solving includes memory recall
and injected context; excludes L1/L2/L3 generation and external acceptance. Record
failed/cancelled provider latency and unknown usage without inventing zero costs.
Checkpoint solving results before bounded promotion. A promotion failure does
not turn an otherwise complete solution into a solving failure. Warm promotion
still finishes or reaches its separate budget before the next stage starts.
Use fresh states and record both visibility and accounting version in reports.
No core runtime API, storage format or memory policy is changed by this adapter.

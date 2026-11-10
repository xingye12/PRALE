# Harness implementation plan

This file records incremental runtime decisions alongside the detailed constraints in AGENTS.md
and the existing feature implementation plans.

## ADR: Main-agent operation step budget

### Background

The main agent can repeatedly generate tool calls or consume hook follow-ups without a bound.
Subagents already have a separate durable max_turns budget.

### Decision

Each non-subagent run has max_steps=120. One step is a newly authorized assistant generation,
including its resulting tool batch. Provider retries and context-summary calls do not consume
additional steps. The final permitted step may complete normally, including its tools. A request
for another step settles the operation as failed with error_code=step_limit_exceeded before any
new generation intent or effect. Hook follow-ups share the same budget. Each newly admitted
operation starts with a fresh budget; subagent max_turns behavior is unchanged.

Persist the consumed count at operation/{id}/steps, atomically with the new assistant effect
intent and span. Recovery uses that count, never process-local state. Missing counts on legacy
operations start at zero; previously executed legacy steps cannot be reconstructed reliably.
The additive value key needs no SQL schema migration and does not rewrite existing entries.

### Consequences and acceptance

Repeated tool calls and follow-ups terminate after 120 generations; a normal final answer at
step 120 completes successfully. Reopening a session or interrupting before effect, after effect,
or before settlement must preserve consumed steps. Retries of an existing intent must not
increment the count. Terminal settlement releases the lane for a new operation.

## ADR: Consecutive repeated tool errors

### Background

A model can repeatedly request the same failing action. OpenClaw's
observeRepeatedToolError quarantines an action on its third consecutive identical failure.

### Decision

For every run, including subagents, track only the last settled error signature and its count.
The signature hashes tool name, canonical JSON arguments, and result content/error_code.
Diagnostic details are excluded. Success, unknown outcomes, or a different signature resets
this streak. On the third identical failure quarantine the action (name plus arguments) for
this operation. Return the original error plus a fixed recovery instruction to the model.
One recovery allowance is available per operation: the next assistant decision can change
inputs, use another tool, or finish. Requesting a quarantined action after that decision is
blocked before effect intent and ends the operation as failed/tool_loop_detected. A second
three-error intervention also terminates. Quarantine survives progress and recovery.

Persist operation/{id}/tool_loop as an additive value, atomically with tool settlements.
Consume the pending recovery allowance atomically with the next assistant generation intent;
provider retries do not consume it again. Calls remaining in the triggering assistant batch
that target quarantined actions are returned as blocked without execution; the recovery
allowance remains available to the next model decision. Repeated identical actions within a
parallel batch are dispatched in successive batches so admission sees preceding outcomes.
Parallel settlements update the streak in assistant source order, not completion order.
Missing legacy state means no observed errors. No schema migration is required.

### Consequences and acceptance

No rolling-history, alternating-pattern, or post-compaction detector is introduced. Error
comparison is exact canonical content, without stripping timestamps. Tests cover the third
failure, blocked fourth execution, changed requests, reset conditions, batches, and durable
intent/effect/settlement interruption boundaries. Detector-generated vetoes are not new
failures and do not reset the streak. Guard messages do not echo raw arguments or errors.

## ADR: Built-in destructive shell command guard

Background: workspace isolation does not prevent destructive workspace operations or remote
side effects. Common destructive commands should be rejected before shell execution.

Decision: classify sudo, filesystem formatting, device dd writes, remote-download pipelines to
shells, forced Git pushes, fork bombs, system power commands, recursive removal of root/home,
and recursive world-writable chmod of root/home as deny. Inspect shell command positions,
common wrappers and literal nested shell commands; apply before sandbox approval and again
before launch, including configured prefixes. Denials cannot be approved. Increment the local
policy version so previous grants are reassessed. No persistence format or effect boundary changes.

Consequences: this is a conservative common-pattern guard, not a complete shell interpreter or
security boundary. Dynamically constructed commands, sourced scripts and other interpreters can
hide operations; retain OS sandboxing. Tests must cover dangerous variants, benign text, direct
execution and runtime rejection without a shell effect or approval request.

## ADR: Bash AST admission guard (supersedes token-based guard)

Background: shlex loses quoting and execution context, so command-looking data can be mistaken
for commands and executable substitutions or redirection arguments can escape classification.

Decision: use tree-sitter-bash AST as a required local-tool dependency. Traverse executable
command nodes, substitutions, function bodies, pipelines and redirects without executing shell
expansions. Decode literal words with quote-aware Bash escaping, including concatenation and
ANSI-C quoting. Only actual HOME/tilde expansions denote home; quoted literal text does not.
Inspect literal shell -c/eval code and shell stdin supplied by here-docs/here-strings. Ordinary
here-doc text remains data; unquoted here-doc substitutions are executable. Track download
sources through pipeline stages and process substitutions, never across separate statements.
Deny parser failures, dynamic executable names and unresolved nested shell code; unresolved
arguments relevant to rm/chmod/dd and Git push are conservatively denied. Other command
arguments remain data. Keep deny before approval and the second check before launch. Advance
guard/policy versions, invalidating previous exact grants; no durable schema changes.

Consequences: conservative AST traversal inspects branches and function bodies even if they may
not execute. It does not interpret general variables, aliases, external scripts, shell startup files,
other languages or all data flows. OS isolation remains necessary. Tests must distinguish quoting,
comments, heredocs, nested substitutions, real pipelines, redirect destinations versus arguments,
wrappers, parser failures and durable runtime rejection with no executor effect.

## ADR: Exclude evaluation directories from repository exploration

Background: local evaluation snapshots and reports can dominate discovery and exceed scan limits.

Decision: add `.eval-state`, `reports`, and `evals` to the default directory-name exclusions,
applying at every depth before traversal and scan-budget accounting, like existing build/cache exclusions.
These directories cannot be included through query hints or include_tests. No cache/session format changes.

Consequences and acceptance: evaluation artifacts no longer contribute files, symbols or references;
ordinary source files remain discoverable. Integration coverage verifies exclusion before max_files enforcement.

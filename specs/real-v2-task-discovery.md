# Real-v2 task discovery

## ADR: Remove target-file hints from prompts and public test support

Background: basic prompts named the repair file; advanced prompts listed every
faulty module. Hiding these lists in basic revision 5 / advanced revision 4 did
not restore discovery: public subject.mjs still mapped scenarios to source paths
and exposed business-specific functions and fakes. In the cancelled basic run,
all twelve cold tasks read the helper before requesting the target source.
Fault injection also changed target-file timestamps, and Git's index retained
the original mtimes even when the visible file times were subsequently reset.

Decision: basic revision 6 / advanced revision 5 use public_support_version 1.
All 24 prompts describe incidents and delivery, without naming target source
paths or the number of faulty modules. The identical public subject.mjs is now
a generic TypeScript VM loader. loadModule accepts a caller-discovered relative
path, imported boundary bindings and an optional trailer. createGraph additionally
accepts caller-selected modules/aliases, per-module builtin overrides and trailers.
It contains no repository-specific paths, business symbols, scenario mapping,
private recovery entry selection or task-specific fakes. Agents write their own
regression adapters after locating the implementation. Existing concrete adapters
remain outside the workspace for hidden behavioral validation only.

Before Git initialization, the controller recopies the entire mutated source
and support tree, preserving symlinks, so creation-time order reflects a normal
copy traversal rather than late fault injection. It normalizes file/directory/
symlink timestamps before git add, preventing index mtime leakage, and again after
baseline initialization. Normalization skips .git and never follows source links.
This preparation is selected only by public_support_version 1; legacy fixtures
and other evaluation suites keep their prior preparation behavior.

Both CLI entry points default to hidden presentation. Legacy listed/hidden
fixtures remain readable. Versioned oracle support selection compares the
read-only helper against the generic source for version 1, uses the original
concrete helper when no support version is present, and rejects unknown versions.
Oracle versions (3/4), target edit scope, hidden behavioral contracts and
fixed/fault/individual-file regression replay requirements are unchanged.

Consequences: removing the task-specific helper requires more independently
written test scaffolding, but retains dependency-free Node 24 validation. The
loader is test infrastructure, not OS isolation. Repository docs, source imports
and normal code relationships remain legitimate discovery evidence. Historical
prompts, archives and cancelled run results are preserved with their original
revisions and must not be pooled with the new protocol. No model evaluation is
restarted as part of this change.

Acceptance: all generated public helpers are identical and contain no corpus
target paths, basenames or business adapters. New and legacy presentation and
support selection are tested. Workspace tests check regular files, directories,
symlinks, clean Git status and uniform Git index mtimes. Independent deterministic
submissions use caller-owned adapters through the public generic loader; existing
healthy/partial/faulty behavioral and regression checks must still pass.

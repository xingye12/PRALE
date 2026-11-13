# Real-v3: comment-free fault injection

## ADR: Independent corpus with no injected fault annotations

Background: real-v2 mutations sometimes replaced statements with comments explicitly
naming the regression, revealing its location and repair semantics in agent source.

Decision: publish `prale-experience-real-v3`, fixture revision 1, with twelve basic
and twelve advanced tasks in `evals/experience-real-v3`. Reuse the immutable pi
capsule and existing behavioral oracles (versions 3 and 4); keep v2 unchanged.
When a v2 mutation substitutes an explanatory comment for a statement, remove the
entire statement line, including its trailing comment. Other mutations preserve
existing source comments but introduce none. Generation rejects added `//` comments.
The generator is `scripts/build_real_experience_v3.py`; `--check` verifies artifacts.

Retain generic public support, discovery prompts, source timestamp normalization,
private-file admission checks and delayed validation artifacts. The v3 benchmark ID
must select the same behavioral and private-file protections as v2. Agent-visible
inputs remain TASK.md, mutated repository source and generic public test support.

Consequences: v3 removes injected annotations, not the intended observable fault.
Original comments and task descriptions can still explain intended behavior. This
is not a security sandbox and does not hide host files without mount isolation.
Use fresh state/report paths; do not silently pool v2 and v3 scores. Source archives
are shared by manifest reference, not duplicated. Tests require healthy code to
pass and every new fault to fail behavior, plus external fixed/fault replay.

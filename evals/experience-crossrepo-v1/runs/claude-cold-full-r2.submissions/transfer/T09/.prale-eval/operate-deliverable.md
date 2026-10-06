# T09 — Operate a local fake linter, normalize the observed result

Repository: `aider` · Mode: `operate` · Task id: `T09`

## What was operated

A fake linter, `.prale-eval/fake_linter.py`, was executed through aider's own
command helper, `aider.run_cmd.run_cmd`, rather than a bespoke wrapper. The
operation under test is ordinary shell-out-to-a-linter:

```
python3 .prale-eval/fake_linter.py sample.py
```

The linter deliberately produces all three observable signals a real linter
emits, so the normalization has something to work with:

| Signal | Content |
| --- | --- |
| stdout | two diagnostics + a `2 problem(s) found` summary |
| stderr | `fake-lint: error: 1 error(s), refusing to pass` |
| exit status | `2` (`EXIT_LINT_FINDINGS`, "findings present") |

## How to run it

From the workspace root:

```
python3 .prale-eval/operate_demo.py
```

The demo installs its import shims, imports `aider.run_cmd`, runs the linter
through `run_cmd`, re-runs it with separate pipes, normalizes the result, writes
`.prale-eval/observed.json`, and prints the normalized object. It exits `0`.

## The contract that shaped the normalization

`run_cmd` returns a **2-tuple** `(exit_status, output)` on every path, and
converts a launch failure into `(1, message)` rather than raising — so a failing
linter is normalized as data, never as an exception.

The decisive detail is in `run_cmd_subprocess`, which starts the child with
`stderr=subprocess.STDOUT` (`aider/run_cmd.py:65`). **stdout and stderr are
merged into one stream before the caller ever sees them.** A naive normalizer
that treats the returned text as "stdout" would silently absorb the linter's
stderr advisory into its diagnostic list — and, because the advisory does not
match the diagnostic grammar, would usually drop it instead.

The normalizer therefore takes the split from a second, raw run of the
*identical* command with separate pipes, and records the difference rather than
assuming it away. The demo reports this as a cross-check:

- `aider_exit_matches_raw_exit: true` — the process return code survives intact
- `aider_stdout_matches_raw_stdout: false` — the merged stream differs from pure
  stdout by exactly the stderr advisory line

That `false` is the finding. It is not an error; it is the contract.

## Normalized operation result

`exit_code: 2` → `status: "fail"`.

Diagnostics parsed from stdout (grammar `<file>:<line>:<col>: <severity> <rule> <message>`):

```json
[
  {"file": "sample.py", "line": 3, "column": 1,  "severity": "warning",
   "rule": "FAKE-LINT0001", "message": "unused import 'os'"},
  {"file": "sample.py", "line": 7, "column": 80, "severity": "error",
   "rule": "FAKE-LINT0002", "message": "line too long (92 > 79)"}
]
```

Counts: 2 diagnostics · 3 stdout lines · 1 stderr line. The `N problem(s) found`
summary line carries no location and is correctly skipped by the parser.

The three streams, side by side:

```json
"streams": {
  "merged": "<2 diagnostics>\n2 problem(s) found\nfake-lint: error: 1 error(s), refusing to pass\n",
  "stdout": "<2 diagnostics>\n2 problem(s) found\n",
  "stderr": "fake-lint: error: 1 error(s), refusing to pass\n"
}
```

`merged` is exactly what `run_cmd` returned; `stdout`/`stderr` are the recovered
split. Exact byte content is in `.prale-eval/observed.json`.

## Source evidence

The acceptance contract names `aider/run_cmd.py`. Three symbols are cited in
`.prale-eval/result.json`:

| Symbol | Lines | Why it matters here |
| --- | --- | --- |
| `run_cmd` | 11–23 | Public entry point; the tty/pexpect/platform dispatch and the `(exit_status, output)` tuple contract |
| `run_cmd_subprocess` | 42–86 | The branch actually taken; `stderr=subprocess.STDOUT` at line 65 causes the merge |
| `run_cmd_pexpect` | 89–132 | The untaken alternative; merges streams too, and can report a nullable `exitstatus` |

## Validation

Primary: `python3 .prale-eval/operate_demo.py` — **passed** (exit 0).

**Limitation.** `pexpect` and `psutil` are not installed and cannot be installed
in this offline environment, so a blind `import aider.run_cmd` fails at
`aider/run_cmd.py:7`. The demo registers inert in-memory `sys.modules` shims for
those two names purely to let the import succeed; they are never called, because
a non-tty Linux run takes the `run_cmd_subprocess` branch, which is pure standard
library. The shims are reported under `normalization.shimmed_imports` rather than
hidden.

A consequence: the repository's focused test,

```
python3 -m pytest tests/basic/test_run_cmd.py -q
```

**cannot** be used as validation. It fails at collection with
`ModuleNotFoundError: No module named 'pexpect'` (exit status 2, 1 error during
collection). This is a pre-existing environment gap, not a result of this task.
Were `pexpect` present, that test asserts the same contract this demo exercises —
`exit_code == 0` and `output.strip() == "Hello, World!"` for `echo`.

No task metadata, hidden-oracle file, lockfile or git configuration was
modified. The only additions are the four files under `.prale-eval/`.

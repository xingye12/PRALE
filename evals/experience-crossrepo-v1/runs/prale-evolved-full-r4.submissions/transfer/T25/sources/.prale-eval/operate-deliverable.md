# T25 `operate` deliverable — local fake linter → normalized lint result

Repository: `aider` · Task: `T25` · Mode: `operate`

## 1. What was operated

An executable demo, runnable from the workspace root:

```bash
python3 .prale-eval/operate_lint_normalize.py
```

It exercises two layers and folds them into one normalized JSON result:

| Layer | Artifact | What it does |
| --- | --- | --- |
| Fake external linter | `.prale-eval/fake_linter.py` | Prints 4 finding lines on **stdout**, 1 diagnostic on **stderr**, then `sys.exit(3)` — a real nonzero exit. |
| Repo command runner | `aider/run_cmd.py` (`run_cmd`, `run_cmd_subprocess`) | AST-extracted from the real source and executed against the same fake linter, observing its `(returncode, combined_output)` contract. |
| Normalizer | `.prale-eval/operate_lint_normalize.py` (`normalize`) | Parses stdout findings, records stderr diagnostics and the exit status, and writes the normalized result. |

The normalized operation result is written to
`.prale-eval/normalized_lint_result.json`.

## 2. Observed behavior (raw signals)

```
$ python3 .prale-eval/fake_linter.py
stdout: src/app.py:1:80: E501 line too long (92 > 79 characters)
stdout: src/app.py:3:1: W291 trailing whitespace
stdout: src/app.py:7:5: F401 'os' imported but unused
stdout: fake_lint: 3 problems found in 1 file
stderr: fake_lint: warning: config .fakelint.toml not found, using defaults
exit  : 3
```

Run through the repository's own runner (`aider.run_cmd.run_cmd`, non-TTY path →
`run_cmd_subprocess`), the same command yields:

```
exit_code = 3            # nonzero status is preserved as data, not raised
output    = "<stdout lines>" + "<stderr line>"   # stderr is merged into stdout
```

`run_cmd_subprocess` builds `subprocess.Popen(..., stderr=subprocess.STDOUT)`
(`aider/run_cmd.py:62-73`), so the runner **cannot** separate the two streams on
its own. The demo therefore captures stdout/stderr individually with
`subprocess.run(capture_output=True)` and uses the runner call to *verify* the
exit-code and stream-merging contract, which is exactly the interoperability
fact a caller of aider's linter plumbing has to handle.

## 3. Normalized schema (`prale.lint-normalized/v1`)

```json
{
  "schema": "prale.lint-normalized/v1",
  "task_id": "T25",
  "repository": "aider",
  "tool": "fake_lint",
  "command": "python3 .prale-eval/fake_linter.py",
  "working_directory": ".",
  "exit_code": 3,
  "status": "fail",
  "streams": {"stdout": "...", "stderr": "...", "stdout_lines": 4, "stderr_lines": 1},
  "issues": [{"file": "src/app.py", "line": 1, "column": 80,
               "code": "E501", "severity": "error",
               "message": "line too long (92 > 79 characters)"}],
  "diagnostics": [{"severity": "warning", "message": "fake_lint: warning: ..."}],
  "summary_lines": ["fake_lint: 3 problems found in 1 file"],
  "counts": {"files": 1, "issues": 3, "errors": 2, "warnings": 1, "diagnostics": 1},
  "runner_contract": {
    "function": "aider.run_cmd.run_cmd",
    "returns": ["returncode", "combined_output"],
    "observed_exit_code": 3,
    "nonzero_exit_preserved": true,
    "stderr_merged_into_stdout": true,
    "stream_separation": "merged",
    "output_mirrored_to_stdout": true,
    "raw_stream_capture": "subprocess.run(capture_output=True)"
  }
}
```

Field contract:

* `exit_code` — verbatim child exit status (`3`); `status` is `fail` iff it is nonzero.
* `issues[]` — one object per `file:line:col: CODE message` stdout line; severity
  derived from the code prefix (`E`/`F` → error, `W` → warning).
* `diagnostics[]` — everything the linter wrote to stderr, kept out of `issues[]`
  because the aider runner would otherwise have folded it into stdout.
* `runner_contract` — the empirically verified behavior of the repository's own
  runner against this exact linter invocation.

## 4. Validation

```bash
python3 .prale-eval/operate_lint_normalize.py
```

Result: exit code `0`, printing `OPERATE CONTRACT HOLDS` after 9 checks
(nonzero exit observed, `status == "fail"`, both streams non-empty, 3 issues
parsed with codes `E501/W291/F401`, runner preserves the nonzero exit, runner
merges stderr into stdout, runner identity is `aider.run_cmd.run_cmd`), plus a
reload check that `.prale-eval/normalized_lint_result.json` round-trips byte-identically.

**Recorded limitation:** `pexpect` is not installed in this environment, so
`import aider.run_cmd` fails at module import (`aider/run_cmd.py:7`). Per task
rules no dependency was installed; instead the real `run_cmd`/`run_cmd_subprocess`
source was AST-extracted from `aider/run_cmd.py` and executed with lightweight
stubs, and stdin was forced to a non-TTY so the subprocess branch (the only
branch reachable here) is the one exercised. The TTY/`pexpect` branch
(`run_cmd_pexpect`) is therefore cited from source only, not executed.

No task metadata, hidden-oracle files, package locks, or git configuration were
modified; the only files added are under `.prale-eval/`.

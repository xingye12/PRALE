# T09 — Operate a local fake linter and normalize its result

Repository: `aider` · Mode: `operate` · Language/runtime: Python 3 (standard library only)

## 1. What was operated

A local *fake* linter, [`tools/fake_linter.py`](../tools/fake_linter.py), was executed against an inert
target file, [`tools/demo_target.py`](../tools/demo_target.py). The fake linter deliberately reproduces the
observable contract of a real linter CLI:

| aspect | behavior |
| --- | --- |
| findings | written to **stdout**, one per line, in `path:line:col: RULE message` form |
| diagnostics | written to **stderr** (config warning, summary, exit-status note) |
| exit status | **1** (nonzero) whenever findings were reported; 2 for a bad invocation, 0 if clean |

Command actually run (from the workspace root):

```console
$ python3 tools/fake_linter.py tools/demo_target.py
fake-linter: warning: no config file found; using defaults          <- stderr
tools/demo_target.py:3:1: E501 line too long (101 > 79 characters)  <- stdout
tools/demo_target.py:5:9: E231 missing whitespace after ':'         <- stdout
fake-linter: 2 problem(s) found in 1 file(s)                        <- stderr
fake-linter: exit status 1 (problems reported)                      <- stderr
$ echo $?
1
```

## 2. The executable demo

[`tools/normalize_lint.py`](../tools/normalize_lint.py) operates that linter and normalizes the observation.

```console
$ python3 tools/normalize_lint.py          # prints the normalized JSON, writes .prale-eval/linter-result.json
$ echo $?
0
```

It uses **two capture paths** and keeps the distinction explicit, because the repository helper does *not*
preserve stream identity:

1. **`aider.run_cmd.run_cmd_subprocess`** — the helper `aider/linter.py` itself uses. It spawns the command
   with `shell=True` and `stderr=subprocess.STDOUT`, echoes each byte to stdout in real time, and returns
   `(process.returncode, "".join(output))`. The observation is therefore a *single merged stream* plus a
   return code; `streams_separated` is `false`.
2. **`subprocess.run(..., stdout=PIPE, stderr=PIPE, text=True)`** — a stream-preserving capture used to build
   the normalized record, so stdout and stderr stay separate and `streams_separated` is `true`.

The demo then cross-checks the two: `run_cmd_merged_union_of_streams == true` means the merged text contains
exactly the same lines as `stdout + stderr` (interleaved, no stream identity) — confirmed empirically, not
assumed.

### Normalized operation result (schema)

`tools/normalize_lint.py` emits the following object (also written to `.prale-eval/linter-result.json`):

```json
{
  "operation": "operate.fake_linter",
  "command": "python3 tools/fake_linter.py tools/demo_target.py",
  "cwd": ".",
  "target": "tools/demo_target.py",
  "exit_code": 1,
  "status": "failed",
  "streams": {
    "stdout": [
      "tools/demo_target.py:3:1: E501 line too long (101 > 79 characters)",
      "tools/demo_target.py:5:9: E231 missing whitespace after ':'"
    ],
    "stderr": [
      "fake-linter: warning: no config file found; using defaults",
      "fake-linter: 2 problem(s) found in 1 file(s)",
      "fake-linter: exit status 1 (problems reported)"
    ],
    "separated": true
  },
  "findings": [
    {"path": "tools/demo_target.py", "line": 3, "column": 1, "rule": "E501", "severity": "error",
     "message": "line too long (101 > 79 characters)", "raw": "...", "parsed": true},
    {"path": "tools/demo_target.py", "line": 5, "column": 9, "rule": "E231", "severity": "error",
     "message": "missing whitespace after ':'", "raw": "...", "parsed": true}
  ],
  "summary": {"problems": 2, "errors": 2, "warnings": 0, "files": ["tools/demo_target.py"]},
  "observations": {
    "stream_preserving_capture": {"helper": "subprocess.run(capture_output=True)", "returncode": 1, "streams_separated": true},
    "repo_run_cmd_subprocess": {"helper": "aider.run_cmd.run_cmd_subprocess", "returncode": 1,
                                "return_shape": "tuple[int, str]", "streams_separated": false},
    "stderr_folded_into_stdout_by_run_cmd": true,
    "run_cmd_merged_union_of_streams": true,
    "run_cmd_merged_line_count": 5,
    "separated_stream_line_count": 5
  },
  "normalization": {
    "stdout_contract": "<path>:<line>:<col>: <RULE> <message>",
    "stderr_contract": "diagnostics/summary lines, not findings",
    "nonzero_exit_means": "failed (findings reported)",
    "normalized_streams": 2
  },
  "validation_limitations": [
    "optional dependency 'pexpect' not installed; stubbed for import only",
    "optional dependency 'psutil' not installed; stubbed for import only"
  ]
}
```

### Normalization rules applied

* **Exit code → status.** `0` → `"passed"`; any nonzero code → `"failed"`. The linter's exit code 1 is a
  *result*, not a harness failure: the normalizer process itself exits `0` when normalization succeeded.
* **Stream attribution.** Only stdout lines matching the finding grammar become `findings`; stderr lines are
  kept verbatim as diagnostics. A line that does not parse is retained as `{"raw": ..., "parsed": false}`
  instead of being silently dropped.
* **Finding grammar.** `^(?P<path>[^:]+):(?P<line>\d+):(?P<col>\d+):\s+(?P<rule>[A-Za-z]+\d+)\s+(?P<message>.*)$`;
  severity is derived from the rule prefix (`E`/`F` → `error`, otherwise `warning`).
* **Summary.** `problems = len(findings)`, split into `errors`/`warnings`, with the distinct normalized file
  paths listed.

## 3. Why the repository helper shapes this result

`aider/run_cmd.py` is the contract that the demo had to respect (citations are repository-relative):

* `run_cmd` (lines 11–23) dispatches to the pexpect path on an interactive TTY, otherwise to the subprocess
  path, and converts `OSError` into `(1, error_message)` — i.e. a nonzero status is a normal return value.
* `run_cmd_subprocess` (lines 42–86) sets `stderr=subprocess.STDOUT`, reads the pipe one character at a time,
  echoes in real time and returns `(process.returncode, "".join(output))`. **Stream identity is lost here**,
  which is exactly why the demo also performs a stream-preserving capture instead of relying on this helper
  for stdout/stderr separation.
* `run_cmd_pexpect` (lines 89–132) has the same `(status, text)` shape for the interactive case, and is the
  reason `pexpect` is a module-scope import.
* `aider/linter.py` `Linter.run_cmd` (lines 47–70) is the in-repo operation being mirrored: it quotes the
  relative filename onto the lint command, runs it via `run_cmd_subprocess`, returns early on exit code 0,
  and otherwise treats the captured (already stderr-merged) text as the error report.

## 4. Validation and limitations

```console
$ python3 tools/validate_lint_normalize.py -v
```

[`tools/validate_lint_normalize.py`](../tools/validate_lint_normalize.py) checks the linter CLI contract, the
normalized record (exit code, status, stream separation, parsed findings, merged-union cross-check), the
`.prale-eval/result.json` metadata contract (`task_id` T09, `repository` aider, `mode` operate, required
keys), and that every evidence citation's declared inclusive line range really contains the named symbol.

**Recorded limitation (not hidden):** `pexpect` and `psutil` are *not installed* in this environment, so
`import aider.run_cmd` fails as-is (`run_cmd.py` imports both at module scope). The demo injects inert
stand-ins into `sys.modules` to reach the non-interactive code path and records
`validation_limitations` in the normalized JSON. Only `run_cmd_subprocess` could actually be executed; the
`run_cmd_pexpect` (TTY) path was verified by reading `aider/run_cmd.py` lines 89–132. No dependencies were
installed, and no repository source, task metadata, hidden-oracle file, package lock or git configuration was
modified.

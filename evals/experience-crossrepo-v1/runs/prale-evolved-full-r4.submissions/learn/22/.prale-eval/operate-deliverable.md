# learn/22 — operate a failing stub command and preserve stdout, stderr, exit code

Repository: `aider` · Mode: `operate` · Task: 22

## What was operated

A stub command (`.prale-eval/stub_fail.py`) that deliberately fails while
touching all three observable fields:

| field | value produced by the stub |
| --- | --- |
| stdout | `STUB_STDOUT: stub wrote to stdout` |
| stderr | `STUB_STDERR: stub wrote to stderr` |
| exit code | `3` |

The executable demo is `.prale-eval/operate_demo.py`. It runs the stub twice:

1. **Through the repository's own machinery** — `aider.run_cmd.run_cmd`, which
   (with non-tty stdin) delegates to `run_cmd_subprocess`. This is the contract
   the repo actually ships.
2. **With separate pipes** (`subprocess.run(..., stdout=PIPE, stderr=PIPE)`) to
   normalize the operation into three distinct, preserved fields.

Run it with:

```
python .prale-eval/operate_demo.py
```

It writes the normalized operation result to `.prale-eval/operate-result.json`
and asserts the invariants below before exiting `0`.

## Repository contract observed (`aider/run_cmd.py`)

- `run_cmd(command, verbose=False, error_print=None, cwd=None)` (lines 11–23)
  dispatches to `run_cmd_pexpect` when `sys.stdin.isatty()` and a pexpect
  `spawn` is available and the platform is not Windows; otherwise it uses
  `run_cmd_subprocess`. Both branches return a **two-tuple**
  `(exit_status, output)`; an `OSError` is converted to `(1, error_message)`.
- `run_cmd_subprocess(...)` (lines 42–86) starts the command with
  `subprocess.Popen(..., stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
  shell=True, ...)` (lines 62–73), streams it byte-by-byte to the real stdout
  (lines 75–81), and returns `process.returncode, "".join(output)` (line 84).
  **Consequence:** `stderr=subprocess.STDOUT` folds stderr into the single
  output field, so operating only through `run_cmd` preserves the exit code and
  a *combined* output, not stdout and stderr as separate fields.
- `run_cmd_pexpect(...)` (lines 89–132) is the interactive branch; it captures
  the terminal stream via `child.interact(output_filter=output_callback)` and
  returns `child.exitstatus, output.getvalue().decode(...)` (line 128) — again a
  two-tuple with a single merged stream.

So the repository's native operation result has **two** fields
(`exit_status`, `combined_output`). The `combined_output` for this run was:

```
STUB_STDERR: stub wrote to stderr
STUB_STDOUT: stub wrote to stdout
```

## Normalized operation result

To preserve **all three** fields, the demo captures the same failing stub with
separate pipes and records:

```json
{
  "operation": "run_failing_stub_command",
  "exit_code": 3,
  "stdout": "STUB_STDOUT: stub wrote to stdout\n",
  "stderr": "STUB_STDERR: stub wrote to stderr\n",
  "fields_preserved": ["stdout", "stderr", "exit_code"],
  "repo_contract": {
    "function": "aider.run_cmd.run_cmd",
    "return_shape": ["exit_status", "combined_output"],
    "stderr_merged_into_stdout": true,
    "exit_status": 3,
    "combined_output": "STUB_STDERR: stub wrote to stderr\nSTUB_STDOUT: stub wrote to stdout\n"
  }
}
```

(The exact `command` string, containing the absolute interpreter path, is in
the JSON artifact.)

## Invariants asserted by the demo

- `exit_code == 3` (the stub's non-zero status survives).
- `STUB_STDOUT` appears in `stdout` and **not** in `stderr`.
- `STUB_STDERR` appears in `stderr` and **not** in `stdout`.
- The repo path `run_cmd` returns `exit_status == 3` and a `combined_output`
  that contains both markers (documenting the merged-stream contract).

## Environment limitation

`pexpect` and `psutil` are optional runtime dependencies of `aider` and are
**not installed** in this image (`import aider.run_cmd` raises
`ModuleNotFoundError: No module named 'pexpect'`; the repo test
`tests/basic/test_run_cmd.py` cannot even be collected for the same reason).
No dependency is installed. Instead the demo injects inert stand-ins into
`sys.modules` so the real, unmodified `aider/run_cmd.py` body can be imported
and exercised. This limitation is recorded in `result.json.validation.notes`.

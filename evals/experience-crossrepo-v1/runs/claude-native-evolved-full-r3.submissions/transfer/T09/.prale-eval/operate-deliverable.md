# T09 — Operate the fake linter and normalize the observed result

Repository: `aider` · Mode: `operate` · Deliverable: `.prale-eval/result.json`

## Executable demo

| File | Role |
| --- | --- |
| `.prale-eval/fake_linter.py` | Local fake linter. Writes findings to **stdout**, a warning to **stderr**, and exits **nonzero (2)**. |
| `.prale-eval/operate_demo.py` | Runs the linter and normalizes the observation. Writes `.prale-eval/operate-observation.json`. |
| `.prale-eval/operate-observation.json` | Machine-readable normalized observation produced by the demo. |

Run it:

```bash
python3 .prale-eval/operate_demo.py
```

## Contract being exercised (grounded in `aider/run_cmd.py`)

- `run_cmd` (`aider/run_cmd.py:11-23`) is the public entry point. It reaches the
  interactive pexpect branch only when stdin is a tty, `pexpect.spawn` exists,
  and the platform is not Windows; otherwise it delegates to
  `run_cmd_subprocess`. Every path returns a `(returncode, output)` pair —
  including the `OSError` path, which returns `(1, error_message)`.
- `run_cmd_subprocess` (`aider/run_cmd.py:42-86`) launches the command with
  `shell=True` and **`stderr=subprocess.STDOUT`**, so the child's stderr is
  merged into the captured output, then returns
  `(process.returncode, "".join(output))`.
- `run_cmd_pexpect` (`aider/run_cmd.py:89-132`) is the tty-only interactive
  variant; unreachable here (no tty, and the optional `pexpect` dependency is
  absent).

## Normalized operation result

The demo produces this normalized object (also embedded at
`validation.observed` in `result.json`):

```json
{
  "operation": "fake-linter-run",
  "command": "python3 .prale-eval/fake_linter.py",
  "observed_via": "run_cmd_subprocess contract mirror (aider/run_cmd.py:42-86)",
  "streams_merged_by_run_cmd": true,
  "exit_code": 2,
  "status": "failed",
  "stdout": "fake_linter: checking fake_target.py\nfake_target.py:1:1: E999 fake syntax finding\nfake_linter: 1 problem found\n",
  "stderr": "fake_linter: warning: no config file, using defaults\n",
  "combined_output": "fake_linter: warning: no config file, using defaults\nfake_linter: checking fake_target.py\nfake_target.py:1:1: E999 fake syntax finding\nfake_linter: 1 problem found\n",
  "findings": [
    {
      "file": "fake_target.py",
      "line": 1,
      "column": 1,
      "code": "E999",
      "message": "fake syntax finding",
      "severity": "error"
    }
  ],
  "diagnostics": ["fake_linter: warning: no config file, using defaults"],
  "dependency_limitation": "ModuleNotFoundError: No module named 'pexpect'"
}
```

Key normalization decisions:

- **Nonzero exit → `status: "failed"`.** Exit code `2` is the linter's deliberate
  signal; the *operation* itself succeeded.
- **Merged stream is authoritative.** Because `run_cmd_subprocess` merges stderr
  into stdout, `combined_output` is the contractually observed channel. Note the
  ordering effect: the unbuffered stderr line appears *before* the buffered
  stdout lines in `combined_output`, so callers must not assume stdout-first
  ordering.
- **Separate channels are reconstructed** by an independent capture (for
  classification only): `stdout` holds the findings, `stderr` the diagnostic.
- **Findings are parsed** from `file:line:col: CODE message` lines into
  structured `{file, line, column, code, message, severity}` records.

## Validation

```bash
python3 .prale-eval/operate_demo.py
```

Status: **passed**. The merged-stream capture and the separate stdout/stderr
capture agreed on exit code `2`; one finding and one diagnostic were normalized.

**Limitation.** The optional dependency `pexpect` is unavailable, so
`from aider.run_cmd import run_cmd` raises `ModuleNotFoundError` (aider/run_cmd.py
imports `pexpect` at line 7). The harness therefore observed the command through
a byte-for-byte mirror of `run_cmd_subprocess` (`aider/run_cmd.py:42-86`) and
recorded the limitation in `dependency_limitation`. With `pexpect` installed the
real `run_cmd` would still select `run_cmd_subprocess`, since the harness runs
without a tty.

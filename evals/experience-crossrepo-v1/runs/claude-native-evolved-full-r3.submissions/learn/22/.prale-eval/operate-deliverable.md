# Operate deliverable — failing stub with stdout / stderr / exit code

Task: `learn/22` · repository `aider` · mode `operate`

## What was operated

A stub command that **fails** and writes to **both** output streams:

```
python -c "import sys; sys.stdout.write('stub-stdout-line\n'); sys.stdout.flush();
           sys.stderr.write('stub-stderr-line\n'); sys.stderr.flush(); sys.exit(3)"
```

Three observable fields are expected from it: `stdout`, `stderr`, `exit_code`.

The demo is executable and self-contained:

```
python .prale-eval/operate_demo.py
```

It writes the machine-readable normalized result to `.prale-eval/operate-result.json`
and asserts on all three fields, exiting non-zero if any is lost.

## Normalized operation result

OS-level capture (`subprocess.run(cmd, shell=True, capture_output=True, text=True)`):

| field       | value                    |
| ----------- | ------------------------ |
| `stdout`    | `stub-stdout-line\n`     |
| `stderr`    | `stub-stderr-line\n`     |
| `exit_code` | `3`                      |

All three fields are preserved byte-for-byte and are distinct from one another.

## The repository contract (aider/run_cmd.py)

`aider.run_cmd.run_cmd` is the function aider really uses to run shell commands
(`aider/commands.py:1015` in `cmd_run` / the `!` command, and
`aider/coders/base_coder.py:2475` in `handle_shell_commands`). Its contract is a
**2-tuple**:

- `run_cmd` (`aider/run_cmd.py:11-23`) dispatches to `run_cmd_pexpect` when stdin
  is a tty and `pexpect.spawn` exists on a non-Windows platform, otherwise to
  `run_cmd_subprocess`. Both branches return `(exit_status, output)`; the
  `OSError` handler returns `(1, error_message)`.
- `run_cmd_subprocess` (`aider/run_cmd.py:42-86`) builds the child with
  `stderr=subprocess.STDOUT` (line 65) and returns
  `(process.returncode, "".join(output))` (line 84). **stderr is merged into
  stdout.**
- `run_cmd_pexpect` (`aider/run_cmd.py:89-132`) captures the pseudo-terminal
  through `output_filter` into one `BytesIO` and returns
  `(child.exitstatus, decoded_buffer)` (line 128). Same collapse.

Running the *same* failing stub through aider's `run_cmd` confirms this
empirically:

```json
{
  "returned_arity": 2,
  "exit_status": 3,
  "combined_output": "stub-stdout-line\nstub-stderr-line\n",
  "stderr_merged_into_stdout": true
}
```

## Contract consequence

`run_cmd` preserves the **exit code** and a **single combined output stream**,
but it does **not** preserve `stdout` and `stderr` as separate fields — the
`stderr=subprocess.STDOUT` merge makes them indistinguishable to any caller
unpacking the 2-tuple. Preserving all three fields therefore requires capturing
the process independently of `run_cmd`'s return value, which is exactly what the
demo does (OS-level `capture_output=True`, then normalization to
`{command, stdout, stderr, exit_code}`).

## Validation

- `python .prale-eval/operate_demo.py` — **passed**. Assertions on
  `exit_code == 3`, `stdout == "stub-stdout-line\n"` and
  `stderr == "stub-stderr-line\n"` all hold; the aider path returned the
  2-tuple with stderr merged.
- `python -m pytest tests/basic/test_run_cmd.py -q` — **could not run**:
  collection fails with `ModuleNotFoundError: No module named 'pexpect'`.

## Limitation

`aider/run_cmd.py` imports `pexpect` and `psutil` at module scope. Neither is
installed in this environment and dependencies must not be installed, so the
repo's own test module cannot even be collected. To exercise the real source
anyway, the demo registers minimal stand-in modules for the two packages **only
when they are absent**. This shim is not on the executed path: stdin is not a
tty here, so `run_cmd` dispatches to `run_cmd_subprocess` exactly as it would in
CI. The `run_cmd_pexpect` tty branch is consequently covered by source
inspection (`aider/run_cmd.py:89-132`, line 128), not execution.

## Files

- `.prale-eval/operate_demo.py` — executable demo (stub + two capture paths + assertions).
- `.prale-eval/operate-result.json` — normalized result written by the demo.
- `.prale-eval/result.json` — required task result with evidence and claims.

No repository source, task metadata, package locks, or git configuration were modified.
